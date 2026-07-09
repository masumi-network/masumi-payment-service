import createHttpError from 'http-errors';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';

// Cross-instance serialization of on-chain settlement per facilitator wallet.
//
// A self-hosted facilitator broadcasts each settle as a tx from a SINGLE EVM account, so the
// account nonce is a shared resource. Two concurrent settles that read the same pending nonce
// collide: one lands, the other reverts as "nonce too low". viem is not given a nonce manager,
// so we serialize settles per facilitator wallet with a row-level lock held ON THE WALLET ITSELF
// (X402EvmWallet.lockedAt) — the same lock pattern Cardano uses for HotWallet.lockedAt. Unlike an
// in-process mutex this holds across horizontally-scaled instances.
//
// Scalability notes:
//  - No DB connection is held while a queued settle waits — each poll runs one short updateMany
//    and returns the connection to the pool, so a large queue does NOT exhaust the pool. (A
//    blocking `SELECT ... FOR UPDATE` would instead pin a connection for the whole settle.)
//  - Poll load is self-limiting: enough contention to matter also drives the queue past
//    MAX_WAIT_MS, so those settles 503 out rather than polling forever.
//  - The hard throughput ceiling is ~1 settle per facilitator wallet per confirmation time (the
//    lock is held across facilitator.settle, which waits for the receipt). Scale HORIZONTALLY by
//    sharding across multiple facilitator wallets per network — the lock key is the wallet, so
//    distinct facilitator wallets never contend.

// A settle that legitimately runs longer than this is treated as impossible; a lock older than
// this means the holder crashed mid-settle, so it may be stolen. Must exceed the slowest real
// settle (broadcast + confirmation on a congested chain) to avoid stealing an ACTIVE lock.
// Exported because reconciliation reuses the bound: a pre-settle marker (or a settlement-less
// Settled attempt) older than this cannot belong to a live settle either, so it is provably
// stuck and safe to surface for manual resolution.
export const SETTLE_STALE_MS = 300_000;
// Max time a settle will queue behind others on the same facilitator before giving up (503).
const MAX_WAIT_MS = 120_000;
// Base poll interval; jitter is added so many waiters don't retry in lockstep (thundering herd).
const POLL_BASE_MS = 150;
const POLL_JITTER_MS = 150;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Atomically take the lock for `walletId` iff it is free or stale. The `updateMany` is a single
// atomic statement, so exactly one of N racing acquirers gets count === 1 (Postgres row lock).
// Returns the timestamp token we wrote (used to release only our own hold), or null if not taken.
async function tryAcquire(walletId: string): Promise<Date | null> {
	const token = new Date();
	const staleBefore = new Date(token.getTime() - SETTLE_STALE_MS);
	const result = await prisma.x402EvmWallet.updateMany({
		where: {
			id: walletId,
			OR: [{ lockedAt: null }, { lockedAt: { lt: staleBefore } }],
		},
		data: { lockedAt: token },
	});
	return result.count === 1 ? token : null;
}

// Release only if we still hold the lock (lockedAt still equals our token). If our settle overran
// SETTLE_STALE_MS and another instance stole the lock, the token no longer matches and this is a
// no-op —
// so we never clear a lock the stealer now holds.
async function releaseLock(walletId: string, token: Date): Promise<void> {
	await prisma.x402EvmWallet.updateMany({
		where: { id: walletId, lockedAt: token },
		data: { lockedAt: null },
	});
}

// Serialize `fn` per facilitator wallet across ALL instances. A null key means a REMOTE
// facilitator, which manages its own nonce/queue server-side → no lock, `fn` runs immediately.
// The lock auto-heals: a crashed holder's stale lock is stolen after SETTLE_STALE_MS.
export async function withFacilitatorSettleLock<T>(key: string | null, fn: () => Promise<T>): Promise<T> {
	if (key == null) return fn();

	const deadline = Date.now() + MAX_WAIT_MS;
	let token = await tryAcquire(key);
	while (token == null) {
		if (Date.now() >= deadline) {
			throw createHttpError(503, 'x402 facilitator is busy settling; retry shortly');
		}
		await sleep(POLL_BASE_MS + Math.floor(Math.random() * POLL_JITTER_MS));
		token = await tryAcquire(key);
	}

	try {
		return await fn();
	} finally {
		// Best-effort release; if it fails the stale-steal timeout still frees the lock eventually.
		await releaseLock(key, token).catch((error) => {
			logger.error('x402 failed to release facilitator settle lock; it will free on the stale timeout', {
				facilitatorWalletId: key,
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}
}
