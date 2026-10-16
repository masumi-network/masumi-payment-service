/**
 * Reservation rollback helper.
 *
 * Correction: the earlier claim that TxInvalid plus expiry rules out a
 * conflicting retry was wrong. Expiry prevents future acceptance but cannot
 * disprove acceptance before expiry in a snapshot the node withheld.
 *
 * Rejection is diagnostic data, not independent proof of nonexecution, so
 * automatic recovery never releases on it. Automatic recovery releases only
 * with `proof: 'spent-by-release-nudge'`, after the reservation's own release
 * nudge, which spends the body's wallet inputs, appeared in a verified snapshot
 * (see `./l2-reservation-recovery` and `./l2-release-nudge-proof`),
 * or with `proof: 'inputs-unspent-in-final-snapshot'`, after a Final head's
 * fanned-out snapshot still held every input (see `./final-l2-reservation-release`).
 */

import {
	PaymentAction,
	Prisma,
	PurchasingAction,
	TransactionLayer,
	TransactionStatus,
} from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { connectPreviousAction, createNextPaymentAction, createNextPurchaseAction } from '@/services/shared';

export interface ReleasableL2Reservation {
	id: string;
	l2ReservationPreviousLayer: TransactionLayer | null;
	l2ReservationPreviousSmartContractWalletId: string | null;
	l2ReservationPreviousBuyerReturnAddress: string | null;
	l2ReservationPreviousCollateralReturn: bigint | null;
	/** The escrow transaction a non-locking action replaced as the request's current one. */
	l2ReservationPreviousTransactionId: string | null;
	/** The signed release nudge the proof was read from, when it read one. */
	l2ReleaseNudgeTx?: string | null;
}

/**
 * The retry action of each non-locking L2 action, keyed by its in-flight one.
 * Mirrors the `retryAction` its service passes to `submitReservedL2Action`.
 */
const PAYMENT_L2_ACTION_RETRY: Partial<Record<PaymentAction, PaymentAction>> = {
	[PaymentAction.SubmitResultInitiated]: PaymentAction.SubmitResultRequested,
	[PaymentAction.WithdrawInitiated]: PaymentAction.WithdrawRequested,
	[PaymentAction.AuthorizeRefundInitiated]: PaymentAction.AuthorizeRefundRequested,
};
const PURCHASE_L2_ACTION_RETRY: Partial<Record<PurchasingAction, PurchasingAction>> = {
	[PurchasingAction.WithdrawRefundInitiated]: PurchasingAction.WithdrawRefundRequested,
	[PurchasingAction.AuthorizeWithdrawalInitiated]: PurchasingAction.AuthorizeWithdrawalRequested,
	[PurchasingAction.SetRefundRequestedInitiated]: PurchasingAction.SetRefundRequestedRequested,
};

export function paymentL2ActionRetry(action: PaymentAction | undefined): PaymentAction | undefined {
	return action === undefined ? undefined : PAYMENT_L2_ACTION_RETRY[action];
}

export function purchaseL2ActionRetry(action: PurchasingAction | undefined): PurchasingAction | undefined {
	return action === undefined ? undefined : PURCHASE_L2_ACTION_RETRY[action];
}

/**
 * Undo one reservation: mark the dead transaction rolled back, give the wallet
 * back, and return each request to where the reservation found it. An initial
 * lock goes back to "needs locking". A non-locking action goes back to its
 * retry action and to the escrow transaction it replaced, as `rollbackL2Action`
 * does for an explicit rejection.
 *
 * Serializable and guarded on the state it expects, so a reservation another
 * writer has already resolved — a late confirmation, a manual clear — is left
 * alone rather than overwritten. A request in an action this cannot map back is
 * left for an operator.
 */
export async function releaseRejectedL2Reservation(
	reservation: ReleasableL2Reservation,
	database: typeof prisma,
	proof: 'head-rejection' | 'spent-by-release-nudge' | 'inputs-unspent-in-final-snapshot',
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
						l2ReleaseNudgeTx: true,
						PurchaseRequestCurrent: {
							select: { id: true, nextActionId: true, NextAction: { select: { requestedAction: true } } },
						},
						PaymentRequestCurrent: {
							select: {
								id: true,
								nextActionId: true,
								NextAction: { select: { requestedAction: true, resultHash: true } },
							},
						},
					},
				});
				if (
					current == null ||
					current.status !== TransactionStatus.Pending ||
					// A TxValid row (txHash set) may already be paired with the seller's
					// PaymentRequest, which this helper does not restore. Keep those manual.
					current.txHash != null ||
					(proof === 'head-rejection' && current.l2RejectedByHeadAt == null) ||
					// The proof holds only for the nudge it was read from. A nudge
					// recorded after the decision may still be in flight; freeing the
					// wallet now would let a new lock select its inputs.
					(reservation.l2ReleaseNudgeTx !== undefined &&
						(current.l2ReleaseNudgeTx ?? null) !== reservation.l2ReleaseNudgeTx)
				) {
					return false;
				}

				// An initial lock only reserves a request with no current transaction,
				// and an action always replaces one. So the reservation, not the
				// request's action now, says which restore applies.
				const previousTransactionId = reservation.l2ReservationPreviousTransactionId;
				const isAction = previousTransactionId != null;
				const actionPurchases = isAction ? current.PurchaseRequestCurrent : [];
				const lockPurchases = isAction ? [] : current.PurchaseRequestCurrent;
				const hasUnmappedAction =
					actionPurchases.some(
						(purchase) => purchaseL2ActionRetry(purchase.NextAction?.requestedAction) === undefined,
					) ||
					(isAction &&
						current.PaymentRequestCurrent.some(
							(payment) => paymentL2ActionRetry(payment.NextAction?.requestedAction) === undefined,
						));
				const hasActionOnLock =
					!isAction &&
					(current.PaymentRequestCurrent.length > 0 ||
						lockPurchases.some(
							(purchase) => purchaseL2ActionRetry(purchase.NextAction?.requestedAction) !== undefined,
						));
				if (hasUnmappedAction || hasActionOnLock) {
					return false;
				}

				await tx.transaction.update({
					where: { id: reservation.id, status: TransactionStatus.Pending },
					data: {
						status: TransactionStatus.RolledBack,
						lastCheckedAt: new Date(),
						...(proof === 'head-rejection' ? {} : { l2ReleasedByInputProofAt: new Date() }),
					},
				});

				// Free the wallet this reservation claimed. Scoped by the pending
				// transaction id so a wallet that has since been claimed by other work
				// is never unlocked underneath it.
				await tx.hotWallet.updateMany({
					where: { pendingTransactionId: reservation.id },
					data: { lockedAt: null, pendingTransactionId: null },
				});

				if (isAction) {
					const restoreCurrent = {
						CurrentTransaction: { connect: { id: previousTransactionId } },
						TransactionHistory: {
							disconnect: { id: previousTransactionId },
							connect: { id: reservation.id },
						},
					};
					for (const payment of current.PaymentRequestCurrent) {
						const resultHash = payment.NextAction?.resultHash;
						await tx.paymentRequest.update({
							where: {
								id: payment.id,
								nextActionId: payment.nextActionId,
								currentTransactionId: reservation.id,
								layer: TransactionLayer.L2,
							},
							data: {
								...connectPreviousAction(payment.nextActionId),
								...createNextPaymentAction(
									paymentL2ActionRetry(payment.NextAction?.requestedAction)!,
									resultHash == null ? undefined : { resultHash },
								),
								...restoreCurrent,
							},
						});
					}
					for (const purchase of actionPurchases) {
						await tx.purchaseRequest.update({
							where: {
								id: purchase.id,
								nextActionId: purchase.nextActionId,
								currentTransactionId: reservation.id,
								layer: TransactionLayer.L2,
							},
							data: {
								...connectPreviousAction(purchase.nextActionId),
								...createNextPurchaseAction(purchaseL2ActionRetry(purchase.NextAction?.requestedAction)!),
								...restoreCurrent,
							},
						});
					}
					return true;
				}

				// Put the request back exactly as the reservation found it, so the next
				// pass is free to choose a different wallet, a different head, or L1.
				for (const purchase of lockPurchases) {
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
