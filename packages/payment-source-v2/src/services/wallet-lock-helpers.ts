// Shared wallet-lock helpers for V2 batch services.
//
// Background: `lockAndQueryX` sets `HotWallet.lockedAt = now` to claim the
// wallet for the duration of a scheduler tick. The shared Transaction's
// BlocksWallet connect ALSO sets `HotWallet.pendingTransactionId`. On the
// success path, tx-sync clears BOTH when the on-chain tx confirms.
//
// On the batch-submit FAILURE path, the rollback `$transaction` calls
// `disconnectTransactionWallet()` which clears ONLY `pendingTransactionId`
// — `lockedAt` stays set. The batch then calls `fallbackToSingleItems(...)`.
// If every single-item attempt defers (LOOKUP_DEFERRED), no item ever
// clears `lockedAt`, and the wallet sits orphan-locked until
// `wallet-timeouts`'s WALLET_LOCK_TIMEOUT_INTERVAL (~30 min) elapses.
//
// `unlockHotWalletIfNoPendingTransaction` atomically clears `lockedAt`
// ONLY when no in-flight tx exists on the wallet — preserving the lock
// when a single-item submit succeeded (tx-sync will release it on
// confirmation) while freeing the wallet when nothing was submitted.

import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';

export async function unlockHotWalletIfNoPendingTransaction(walletId: string, serviceLabel: string): Promise<void> {
	try {
		const result = await prisma.hotWallet.updateMany({
			where: { id: walletId, deletedAt: null, pendingTransactionId: null },
			data: { lockedAt: null },
		});
		if (result.count === 0) {
			// Either the wallet has an in-flight pendingTransactionId (single-item
			// submit succeeded — tx-sync owns the unlock) or the wallet row is
			// gone. Either way, intentional no-op.
			return;
		}
	} catch (error) {
		logger.warn('unlockHotWalletIfNoPendingTransaction failed (non-fatal)', {
			walletId,
			serviceLabel,
			error: error instanceof Error ? { name: error.name, message: error.message } : error,
		});
	}
}
