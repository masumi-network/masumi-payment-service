import { Prisma } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { CONFIG } from '@masumi/payment-core/config';

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
 */
export async function unlockStaleOrphanWalletLocks(): Promise<void> {
	const cutoff = new Date(Date.now() - CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL);
	// Same predicate for the diagnostic read and the write. `updateMany`
	// re-evaluates it atomically, so a wallet that acquires a pending tx between
	// the two queries is not cleared.
	const staleLockFilter: Prisma.HotWalletWhereInput = {
		deletedAt: null,
		pendingTransactionId: null,
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
