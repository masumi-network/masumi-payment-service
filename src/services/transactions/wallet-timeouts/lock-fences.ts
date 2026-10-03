/**
 * The compare-and-swap predicates the wallet-timeout sweeps write through.
 *
 * Split out of service.ts, which is long enough that these were easy to miss —
 * and missing one is how an unfenced clear gets written. Everything here is a
 * pure `where` builder over HotWallet, so it is testable without a database and
 * without the sweep around it.
 */

import { TransactionLayer, type Prisma } from '@/generated/prisma/client';

export function isL1PendingTransaction(
	pendingTransaction: { layer: TransactionLayer } | null,
): pendingTransaction is { layer: typeof TransactionLayer.L1 } {
	return pendingTransaction?.layer === TransactionLayer.L1;
}

export function buildInvalidPendingWalletSweepWhere(): Prisma.HotWalletWhereInput {
	return {
		PendingTransaction: { layer: TransactionLayer.L1 },
		lockedAt: null,
		deletedAt: null,
	};
}

export function buildInvalidPendingWalletReleaseWhere(
	walletId: string,
	pendingTransactionId: string,
): Prisma.HotWalletWhereInput {
	return {
		id: walletId,
		deletedAt: null,
		lockedAt: null,
		pendingTransactionId,
		PendingTransaction: { layer: TransactionLayer.L1 },
	};
}

/**
 * The compare-and-swap every unlock in this file writes through.
 *
 * Each sweep reads a batch of wallets, does work, then clears the lock — and
 * between the read and the write another holder can legitimately take the same
 * wallet. A Hydra L1 deposit is the dangerous one: it holds its wallet across a
 * full L1 confirmation and never attaches a PendingTransaction, so every
 * predicate these sweeps select on is also true of a perfectly healthy deposit
 * moments after it claims. Clearing by wallet id alone frees that deposit
 * mid-carve, hands the wallet to the batchers, and one of the two spends over
 * the same input dies on chain as BadInputsUTxO.
 *
 * Each builder therefore names the state its sweep actually observed; a write
 * that matches no row means the wallet moved on and is left alone.
 */
export function buildSwapUnlockWhere(walletId: string, swapTransactionId: string): Prisma.HotWalletWhereInput {
	return { id: walletId, deletedAt: null, pendingSwapTransactionId: swapTransactionId };
}

export function buildOrphanLockClearWhere(walletId: string, lockedBefore: Date): Prisma.HotWalletWhereInput {
	return {
		id: walletId,
		deletedAt: null,
		pendingTransactionId: null,
		lockPurpose: null,
		// The read that selected this row also required the lock to be older than
		// the timeout, and leaving that out of the write is not a smaller fence —
		// it is a different one. A batcher claims a wallet by setting `lockedAt`
		// alone and attaches its PendingTransaction a moment later, so a lock
		// taken seconds ago matches every other column here. Clearing it hands
		// the same wallet to a second batcher mid-build, and one of the two
		// spends over the same input dies on chain as BadInputsUTxO.
		lockedAt: { lt: lockedBefore },
	};
}

export function buildTimedOutUnlockWhere(walletId: string, lockedBefore: Date): Prisma.HotWalletWhereInput {
	return {
		id: walletId,
		deletedAt: null,
		pendingTransactionId: null,
		pendingSwapTransactionId: null,
		lockPurpose: null,
		// See `buildOrphanLockClearWhere`: the age is part of what was observed,
		// so it is part of what is fenced on.
		lockedAt: { lt: lockedBefore },
	};
}

/**
 * Clearing the swap half-state — a wallet holding a PendingSwapTransaction with
 * no lock at all — leaves the same wallet id, and nothing else, to write by.
 *
 * A swap that starts in that gap claims the wallet by setting `lockedAt` and
 * attaching its own PendingSwapTransaction, and the unfenced clear then
 * detached that live swap from its wallet: the transaction is on chain, the
 * wallet says it is holding nothing, and the sweep that reconciles them by
 * pending id can no longer find it. Fenced on the swap id that was read and on
 * the lock still being absent, a wallet that moved on matches nothing.
 *
 * `lockPurpose` is cleared with it. It is only ever set together with
 * `lockedAt`, so a row matching this fence should not carry one; if it does,
 * leaving it behind would strand the wallet in a state no sweep selects.
 */
export function buildSwapHalfStateClearWhere(
	walletId: string,
	pendingSwapTransactionId: string,
): Prisma.HotWalletWhereInput {
	return { id: walletId, deletedAt: null, lockedAt: null, pendingSwapTransactionId };
}
