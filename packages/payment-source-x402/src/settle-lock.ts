import createHttpError from 'http-errors';
import { Prisma, prisma } from '@masumi/payment-core/db';
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
//  - No DB connection is held while a queued settle waits — each poll runs one short atomic UPDATE
//    and returns the connection to the pool, so a large queue does NOT exhaust the pool. (A
//    blocking `SELECT ... FOR UPDATE` would instead pin a connection for the whole settle.)
//  - Poll load is self-limiting: enough contention to matter also drives the queue past
//    MAX_WAIT_MS, so those settles 503 out rather than polling forever.
//  - The hard throughput ceiling is ~1 settle per facilitator wallet per confirmation time (the
//    lock is held across facilitator.settle, which waits for the receipt). Scale HORIZONTALLY by
//    sharding across multiple facilitator wallets per network — the lock key is the wallet, so
//    distinct facilitator wallets never contend.

// Maximum age of an UNRENEWED settle lease. Healthy long-running settles may exceed this duration:
// they renew both the wallet lock and attempt marker below. A timestamp older than this means the
// holder stopped heartbeating, so the lock may be stolen and its attempt surfaced for resolution.
export const SETTLE_STALE_MS = 300_000;
// Renew well inside the stale window. This keeps a healthy long-running settle from having its
// nonce lock stolen and gives two more renewal opportunities before the lock can become stale if
// one database heartbeat fails transiently.
export const SETTLE_LOCK_HEARTBEAT_MS = Math.floor(SETTLE_STALE_MS / 3);
// Max time a settle will queue behind others on the same facilitator before giving up (503).
const MAX_WAIT_MS = 120_000;
// Base poll interval; jitter is added so many waiters don't retry in lockstep (thundering herd).
const POLL_BASE_MS = 150;
const POLL_JITTER_MS = 150;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// All lease participants compare timestamps written by different application instances. Use the
// database as the single clock source so host clock skew cannot make one node steal another node's
// live lock or reconcile its active attempt early.
export async function getX402DatabaseNow(client: Pick<Prisma.TransactionClient, '$queryRaw'> = prisma): Promise<Date> {
	const [row] = await client.$queryRaw<Array<{ now: Date }>>`
		SELECT clock_timestamp() AS "now"
	`;
	if (!(row?.now instanceof Date) || Number.isNaN(row.now.getTime())) {
		throw createHttpError(500, 'Failed to read the database clock for x402 settlement');
	}
	return row.now;
}

// Serialize the short check-and-create step for one payment payload across every process and
// facilitator mode. The wallet lock below cannot cover remote facilitators (they have no local
// wallet row), while a plain findFirst + create allows two remote requests to both pass the check.
//
// This transaction-level advisory lock is held only until the durable Verified marker commits —
// never across the remote/on-chain settle. `hashtextextended` can theoretically collide, but the
// callback still checks the full payload hash, so a collision only serializes unrelated claims.
export async function withPaymentPayloadSettleClaim<T>(
	paymentPayloadHash: string,
	claim: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
	return prisma.$transaction(async (tx) => {
		// Materialize the volatile lock call but return an ordinary integer; returning PostgreSQL's
		// `void` pseudo-type directly is not portable across Prisma driver adapters.
		await tx.$queryRaw<Array<{ acquired: number }>>`
			WITH payload_lock AS MATERIALIZED (
				SELECT pg_advisory_xact_lock(hashtextextended(${paymentPayloadHash}, 0))
			)
			SELECT 1 AS acquired FROM payload_lock
		`;
		return claim(tx);
	});
}

// Atomically take the lock for `walletId` iff it is free or stale. The database computes both the
// stale boundary and the new ownership token inside the same UPDATE, so a paused application
// process can never write a token that was already stale before the row changed.
// Returns the timestamp token PostgreSQL wrote (used to release only our own hold), or null.
async function tryAcquire(walletId: string): Promise<Date | null> {
	const [lease] = await prisma.$queryRaw<Array<{ lockedAt: Date }>>`
		UPDATE "X402EvmWallet"
		SET "lockedAt" = clock_timestamp()
		WHERE "id" = ${walletId}
			AND (
				"lockedAt" IS NULL
				OR "lockedAt" < clock_timestamp() - make_interval(secs => ${SETTLE_STALE_MS / 1000}::double precision)
			)
		RETURNING "lockedAt"
	`;
	if (lease == null) return null;
	if (!(lease.lockedAt instanceof Date) || Number.isNaN(lease.lockedAt.getTime())) {
		throw createHttpError(500, 'Failed to acquire the x402 facilitator settle lease');
	}
	return lease.lockedAt;
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

// Compare-and-renew: only the current holder can move lockedAt forward. Returning null means the
// row no longer contains our token, so another process owns the lock and this settle must not be
// reported as an ordinary success even if its in-flight chain call later returns.
async function renewLock(walletId: string, token: Date): Promise<Date | null> {
	const [lease] = await prisma.$queryRaw<Array<{ lockedAt: Date }>>`
		UPDATE "X402EvmWallet"
		SET "lockedAt" = clock_timestamp()
		WHERE "id" = ${walletId}
			AND "lockedAt" = ${token}
		RETURNING "lockedAt"
	`;
	if (lease == null) return null;
	if (!(lease.lockedAt instanceof Date) || Number.isNaN(lease.lockedAt.getTime())) {
		throw createHttpError(500, 'Failed to renew the x402 facilitator settle lease');
	}
	return lease.lockedAt;
}

// Serialize `fn` per facilitator wallet across ALL instances. A null key means a REMOTE
// facilitator, which manages its own nonce/queue server-side → no lock, `fn` runs immediately.
// The lock auto-heals: a crashed holder's stale lock is stolen after SETTLE_STALE_MS.
export async function withFacilitatorSettleLock<T>(
	key: string | null,
	fn: () => Promise<T>,
	options: {
		onHeartbeat?: (databaseNow: Date) => Promise<void>;
		// A durable pre-settle marker makes a thrown facilitator call ambiguous: it may have
		// broadcast before throwing. Keep the nonce lease until it becomes stale in that case.
		retainLeaseOnError?: () => boolean;
	} = {},
): Promise<T> {
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

	let currentToken = token;
	let hasLostLock = false;
	let shouldRelease = true;
	let hasHeartbeatIntervalElapsed = false;
	// Keep the mutable promise in an object: TypeScript otherwise treats the local as permanently
	// null because assignments happen in the timer callback, even though that callback runs later.
	const heartbeatState: { pending: Promise<void> | null } = { pending: null };
	const heartbeatTimer = setInterval(() => {
		hasHeartbeatIntervalElapsed = true;
		// Never overlap compare-and-renew calls: the second would use a token the first may have
		// replaced and falsely conclude that this process lost its lock.
		if (heartbeatState.pending != null) return;
		heartbeatState.pending = (async () => {
			const renewedToken = await renewLock(key, currentToken);
			if (renewedToken == null) {
				hasLostLock = true;
				logger.error('x402 facilitator settle lock heartbeat lost ownership', { facilitatorWalletId: key });
				return;
			}
			currentToken = renewedToken;
			if (options.onHeartbeat != null) {
				await options.onHeartbeat(currentToken).catch((error) => {
					logger.error('x402 failed to heartbeat the active settle attempt', {
						facilitatorWalletId: key,
						error: error instanceof Error ? error.message : String(error),
					});
				});
			}
		})()
			.catch((error) => {
				// A transient DB error does not prove ownership was lost. Keep the current token and
				// retry on the next interval; the stale window leaves room for multiple attempts.
				logger.error('x402 failed to renew facilitator settle lock', {
					facilitatorWalletId: key,
					error: error instanceof Error ? error.message : String(error),
				});
			})
			.finally(() => {
				heartbeatState.pending = null;
			});
	}, SETTLE_LOCK_HEARTBEAT_MS);
	heartbeatTimer.unref();

	try {
		let result: T;
		try {
			result = await fn();
		} catch (error) {
			clearInterval(heartbeatTimer);
			const pendingHeartbeat = heartbeatState.pending;
			if (pendingHeartbeat != null) await pendingHeartbeat;

			if (options.retainLeaseOnError?.() === true) {
				// Once the marker exists, a thrown external call is indistinguishable from a
				// post-broadcast transport failure. Refresh the lease before retaining it so a
				// queued settlement cannot immediately steal the signer nonce.
				shouldRelease = false;
				try {
					const retainedToken = await renewLock(key, currentToken);
					if (retainedToken != null) {
						currentToken = retainedToken;
					} else {
						logger.error('x402 could not retain facilitator settle lock after an ambiguous error', {
							facilitatorWalletId: key,
							reason: 'lock ownership was already lost',
						});
					}
				} catch (retainError) {
					// Do not release the last token when refreshing it is unavailable. If it still
					// belongs to us, the stale timeout remains the safest recovery boundary.
					logger.error('x402 failed to retain facilitator settle lock after an ambiguous error', {
						facilitatorWalletId: key,
						error: retainError instanceof Error ? retainError.message : String(retainError),
					});
				}
			}
			throw error;
		}
		clearInterval(heartbeatTimer);
		const finalHeartbeat = heartbeatState.pending;
		if (finalHeartbeat != null) await finalHeartbeat;

		// A failed periodic heartbeat is not enough to prove whether ownership was retained:
		// another process may steal the now-stale lease before the next interval observes it.
		// Fence the completed external call with one final compare-and-renew so a result is only
		// returned while this process demonstrably still owns the wallet lock. Treat an unavailable
		// database as ambiguous too; funds may already have moved, so the attempt must reconcile.
		let finalToken: Date | null;
		try {
			finalToken = await renewLock(key, currentToken);
		} catch (error) {
			// The external call completed but ownership cannot be proved. Leave any lock we still
			// own to expire naturally so reconciliation remains fenced for the full stale window.
			shouldRelease = false;
			logger.error('x402 failed to confirm facilitator settle lock ownership', {
				facilitatorWalletId: key,
				error: error instanceof Error ? error.message : String(error),
			});
			throw createHttpError(
				409,
				'x402 facilitator settle lock ownership could not be confirmed; settlement requires reconciliation',
			);
		}
		if (hasLostLock || finalToken == null) {
			throw createHttpError(409, 'x402 facilitator settle lock was lost; settlement requires reconciliation');
		}
		currentToken = finalToken;
		if (options.onHeartbeat != null && hasHeartbeatIntervalElapsed) {
			try {
				// Persistence runs immediately after this lock scope. A mandatory final attempt
				// heartbeat prevents a long-running settle whose periodic attempt updates failed from
				// becoming reconcilable in the small window between lock release and outcome write.
				await options.onHeartbeat(currentToken);
			} catch (error) {
				shouldRelease = false;
				logger.error('x402 failed to fence the completed settle attempt', {
					facilitatorWalletId: key,
					error: error instanceof Error ? error.message : String(error),
				});
				throw createHttpError(409, 'x402 completed settlement could not be fenced; settlement requires reconciliation');
			}
		}
		return result;
	} finally {
		clearInterval(heartbeatTimer);
		// Avoid racing a renewal that already started: it may replace currentToken immediately
		// before release, which would otherwise leave the renewed lock behind until it goes stale.
		const heartbeat = heartbeatState.pending;
		if (heartbeat != null) await heartbeat;
		if (shouldRelease) {
			// Best-effort release; if it fails the stale-steal timeout still frees the lock eventually.
			await releaseLock(key, currentToken).catch((error) => {
				logger.error('x402 failed to release facilitator settle lock; it will free on the stale timeout', {
					facilitatorWalletId: key,
					error: error instanceof Error ? error.message : String(error),
				});
			});
		}
	}
}
