/**
 * Legacy reservation rollback helper. Automatic recovery must not call this.
 *
 * Correction: the earlier claim that TxInvalid plus expiry rules out a
 * conflicting retry was wrong. Expiry prevents future acceptance but cannot
 * disprove acceptance before expiry in a snapshot the node withheld.
 *
 * Rejection is diagnostic data, not independent proof of nonexecution.
 * Recovery now retains these reservations for explicit reconciliation.
 */

import { Prisma, PurchasingAction, TransactionLayer, TransactionStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { connectPreviousAction, createNextPurchaseAction } from '@/services/shared';

export interface ReleasableL2Reservation {
	id: string;
	l2ReservationPreviousLayer: TransactionLayer | null;
	l2ReservationPreviousSmartContractWalletId: string | null;
	l2ReservationPreviousBuyerReturnAddress: string | null;
	l2ReservationPreviousCollateralReturn: bigint | null;
}

/**
 * Undo one reservation: return the purchase to "needs locking", give the wallet
 * back, and mark the dead transaction rolled back.
 *
 * Serializable and guarded on the state it expects, so a reservation another
 * writer has already resolved — a late confirmation, a manual clear — is left
 * alone rather than overwritten.
 */
export async function releaseRejectedL2Reservation(
	reservation: ReleasableL2Reservation,
	database: typeof prisma = prisma,
): Promise<boolean> {
	try {
		return await database.$transaction(
			async (tx) => {
				// Re-read under the transaction: the gate that selected this row ran
				// against an earlier snapshot, and a confirmation arriving in between
				// must win.
				const current = await tx.transaction.findUnique({
					where: { id: reservation.id },
					select: {
						status: true,
						txHash: true,
						l2RejectedByHeadAt: true,
						PurchaseRequestCurrent: { select: { id: true, nextActionId: true } },
					},
				});
				if (
					current == null ||
					current.status !== TransactionStatus.Pending ||
					current.txHash != null ||
					current.l2RejectedByHeadAt == null
				) {
					return false;
				}

				await tx.transaction.update({
					where: { id: reservation.id, status: TransactionStatus.Pending },
					data: { status: TransactionStatus.RolledBack, lastCheckedAt: new Date() },
				});

				// Free the wallet this reservation claimed. Scoped by the pending
				// transaction id so a wallet that has since been claimed by other work
				// is never unlocked underneath it.
				await tx.hotWallet.updateMany({
					where: { pendingTransactionId: reservation.id },
					data: { lockedAt: null, pendingTransactionId: null },
				});

				// Put the request back exactly as the reservation found it, so the next
				// pass is free to choose a different wallet, a different head, or L1.
				for (const purchase of current.PurchaseRequestCurrent) {
					await tx.purchaseRequest.update({
						where: { id: purchase.id, nextActionId: purchase.nextActionId },
						data: {
							layer: reservation.l2ReservationPreviousLayer ?? undefined,
							buyerReturnAddress: reservation.l2ReservationPreviousBuyerReturnAddress,
							collateralReturnLovelace: reservation.l2ReservationPreviousCollateralReturn,
							...(reservation.l2ReservationPreviousSmartContractWalletId == null
								? { SmartContractWallet: { disconnect: true } }
								: {
										SmartContractWallet: {
											connect: { id: reservation.l2ReservationPreviousSmartContractWalletId },
										},
									}),
							CurrentTransaction: { disconnect: true },
							...connectPreviousAction(purchase.nextActionId),
							...createNextPurchaseAction(PurchasingAction.FundsLockingRequested),
						},
					});
				}

				return true;
			},
			{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
		);
	} catch (error) {
		if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
			// Another writer owns the request now. Leaving its state intact is the
			// whole point of the guards.
			logger.info('[HydraReconcile] release raced another writer; leaving the reservation alone', {
				transactionId: reservation.id,
			});
			return false;
		}
		throw error;
	}
}
