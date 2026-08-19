import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { CONFIG } from '@masumi/payment-core/config';
import { HOT_WALLET_LOCK_STALE_AFTER_MS, HYDRA_L1_LOCK_PURPOSE } from '@/utils/db/hot-wallet-lock';

/**
 * Safety-net reaper for LEAKED wallet locks.
 *
 * `lockAndQueryX` claims a HotWallet by setting `lockedAt = now`; the caller is
 * then expected to build + submit a tx and connect a PendingTransaction. If the
 * caller throws or exits between those two steps the wallet is left with
 * `lockedAt` set but `pendingTransactionId = null`. The relation-driven reapers
 * only release wallets that HAVE a PendingTransaction, so such a wallet — and
 * every request queued behind it — stays locked forever.
 *
 * This clears `lockedAt` for any wallet locked longer than
 * WALLET_LOCK_TIMEOUT_INTERVAL with no pending transaction. The timeout gate is
 * essential: the normal flow holds the lock for ~10-30s (build/sign/submit)
 * before attaching its PendingTransaction, so only freeing locks older than the
 * timeout (default 300s) can never race an in-flight tick.
 *
 * An equivalent branch already lives inline in `updateWalletTransactionHash`;
 * this runs as its own lightweight job so the safety net can't be starved by
 * that heavier, mutex-guarded reconciliation sweep.
 *
 * A lock carrying a `lockPurpose` is not a batcher's and is exempt from that
 * timeout. The Hydra L1 deposits hold their wallet across a full L1
 * confirmation and never attach a PendingTransaction, so they match the orphan
 * shape exactly while being entirely healthy — clearing one at 300s handed the
 * wallet to a batcher mid-carve, and one of the two spends then died on chain
 * as `BadInputsUTxO`. They get their own, much longer pass below.
 */
export async function unlockStaleOrphanWalletLocks(): Promise<void> {
	await unlockStaleBatcherWalletLocks();
	await unlockStalePurposeWalletLocks();
}

async function unlockStaleBatcherWalletLocks(): Promise<void> {
	const cutoff = new Date(Date.now() - CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL);
	// Same predicate for the diagnostic read and the write. `updateMany`
	// re-evaluates it atomically, so a wallet that acquires a pending tx between
	// the two queries is not cleared.
	const staleLockFilter: Prisma.HotWalletWhereInput = {
		deletedAt: null,
		pendingTransactionId: null,
		lockPurpose: null,
		lockedAt: { lt: cutoff },
	};
	try {
		const candidates = await prisma.hotWallet.findMany({
			where: staleLockFilter,
			select: { id: true, type: true },
		});
		if (candidates.length === 0) return;
		const { count } = await prisma.hotWallet.updateMany({
			where: staleLockFilter,
			data: { lockedAt: null },
		});
		if (count > 0) {
			// WARN, not INFO: a cleared lock means some caller leaked it, so this
			// should be visible to operators as a signal worth investigating.
			logger.warn('Cleared stale orphan wallet locks (locked past timeout, no pending tx)', {
				cleared: count,
				walletIds: candidates.map((wallet) => wallet.id),
				timeoutMs: CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL,
			});
		}
	} catch (error) {
		logger.error('unlockStaleOrphanWalletLocks failed', {
			error: error instanceof Error ? { message: error.message, name: error.name } : error,
		});
	}
}

/**
 * The same safety net for locks that name a purpose, on their own clock.
 *
 * `claimHotWalletForL1` already takes over a lock older than
 * HOT_WALLET_LOCK_STALE_AFTER_MS, so a leaked one never blocks another Hydra
 * deposit. It does block every L1 batcher on that wallet, though, because they
 * only ever select `lockedAt: null` — so a crash between claim and release
 * would stop the wallet collecting or paying anything until an operator noticed.
 * This clears it on the same threshold the claim uses.
 */
async function unstickPurposeLocks(purpose: string, staleAfterMs: number): Promise<void> {
	const staleLockFilter: Prisma.HotWalletWhereInput = {
		deletedAt: null,
		pendingTransactionId: null,
		lockPurpose: purpose,
		// The `lockedAt: null` branch is not redundant. Prisma's `lt` does not
		// match NULL, so without it a marker left behind on an ALREADY UNLOCKED row
		// was invisible to the only sweep written for it — while every 300s orphan
		// reaper skips the row for having a marker at all. The wallet then falls out
		// of all of them, and the next batcher to claim it inherits the marker: it
		// ages out at the Hydra timeout instead of the batcher's, and the next
		// `releaseHotWalletAfterL1` for that participant frees the batcher's lock
		// during its build window.
		//
		// A marker with no `lockedAt` has no holder by definition — a Hydra claim
		// always writes both — so it is cleared on sight rather than on a timeout.
		OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(Date.now() - staleAfterMs) } }],
	};
	const candidates = await prisma.hotWallet.findMany({ where: staleLockFilter, select: { id: true } });
	if (candidates.length === 0) return;
	const { count } = await prisma.hotWallet.updateMany({
		where: staleLockFilter,
		data: { lockedAt: null, lockPurpose: null },
	});
	if (count > 0) {
		logger.warn(
			'Cleared stale purpose-marked wallet locks (past their own timeout or already unlocked, no pending tx)',
			{
				cleared: count,
				purpose,
				walletIds: candidates.map((wallet) => wallet.id),
				timeoutMs: staleAfterMs,
			},
		);
	}
}

async function unlockStalePurposeWalletLocks(): Promise<void> {
	try {
		await unstickPurposeLocks(HYDRA_L1_LOCK_PURPOSE, HOT_WALLET_LOCK_STALE_AFTER_MS);
	} catch (error) {
		logger.error('unlockStalePurposeWalletLocks failed', {
			error: error instanceof Error ? { message: error.message, name: error.name } : error,
		});
	}
}
