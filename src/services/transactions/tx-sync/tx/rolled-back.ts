import { prisma } from '@masumi/payment-core/db';
import {
	PaymentAction,
	PaymentErrorType,
	PurchaseErrorType,
	PurchasingAction,
	TransactionStatus,
} from '@/generated/prisma/client';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { TxSyncBeforeWrite } from '../quarantine/fenced-write';

export async function updateRolledBackTransaction(
	rolledBackTx: Array<{ tx_hash: string }>,
	beforeWrite?: TxSyncBeforeWrite,
) {
	for (const tx of rolledBackTx) {
		const foundTransaction = await prisma.transaction.findMany({
			where: {
				txHash: tx.tx_hash,
			},
			select: { id: true },
		});
		for (const transaction of foundTransaction) {
			// Atomic rollback for one Transaction: mark it `RolledBack`, unlock
			// its BlocksWallet, and flag every PaymentRequest / PurchaseRequest
			// that references it as `WaitingForManualAction`. Running this as a
			// single Postgres transaction (with retry-on-serialization-conflict)
			// guarantees we never end up half-flagged — a partial failure had
			// the potential to leave the wallet unlocked while some requests
			// still pointed at the rolled-back Transaction, blocking operator
			// recovery on those rows. Retry handles the inevitable
			// contention with concurrent scheduler ticks that touch the same
			// HotWallet row.
			await retryOnSerializationConflict(
				() =>
					prisma.$transaction(
						async (innerTx) => {
							await beforeWrite?.(innerTx);
							const freshTransaction = await innerTx.transaction.findUniqueOrThrow({
								where: { id: transaction.id },
								include: {
									PaymentRequestCurrent: true,
									PaymentRequestHistory: true,
									PurchaseRequestCurrent: true,
									PurchaseRequestHistory: true,
									BlocksWallet: true,
								},
							});
							await innerTx.transaction.update({
								where: { id: transaction.id },
								data: {
									status: TransactionStatus.RolledBack,
									BlocksWallet: freshTransaction.BlocksWallet ? { disconnect: true } : undefined,
								},
							});
							if (freshTransaction.BlocksWallet != null) {
								await innerTx.hotWallet.update({
									where: { id: freshTransaction.BlocksWallet.id },
									data: {
										lockedAt: null,
									},
								});
							}

							// PaymentRequestCurrent / PurchaseRequestCurrent are arrays since the
							// V2 batch flow can reference one Transaction from N requests
							// (currentTransactionId no longer @unique). For each affected request
							// we move the current NextAction to history and write a new
							// WaitingForManualAction so the operator can inspect the rollback.
							// Automatic resync is intentionally NOT done here — rollbacks may
							// signal datum drift or external double-spends, neither of which
							// is safe to retry without operator review.
							const paymentRequestsToFlag = [
								...freshTransaction.PaymentRequestCurrent.map((pr) => ({
									id: pr.id,
									nextActionId: pr.nextActionId,
								})),
								...freshTransaction.PaymentRequestHistory.map((pr) => ({
									id: pr.id,
									nextActionId: pr.nextActionId,
								})),
							];
							for (const pr of new Map(paymentRequestsToFlag.map((request) => [request.id, request])).values()) {
								await innerTx.paymentRequest.update({
									where: { id: pr.id },
									data: {
										ActionHistory: { connect: { id: pr.nextActionId } },
										NextAction: {
											upsert: {
												update: {
													requestedAction: PaymentAction.WaitingForManualAction,
													errorNote:
														'Rolled back transaction detected. Please check the transaction and manually resolve the issue.',
													errorType: PaymentErrorType.Unknown,
												},
												create: {
													requestedAction: PaymentAction.WaitingForManualAction,
													errorNote:
														'Rolled back transaction detected. Please check the transaction and manually resolve the issue.',
													errorType: PaymentErrorType.Unknown,
												},
											},
										},
									},
								});
							}
							const purchaseRequestsToFlag = [
								...freshTransaction.PurchaseRequestCurrent.map((pr) => ({
									id: pr.id,
									nextActionId: pr.nextActionId,
								})),
								...freshTransaction.PurchaseRequestHistory.map((pr) => ({
									id: pr.id,
									nextActionId: pr.nextActionId,
								})),
							];
							for (const pr of new Map(purchaseRequestsToFlag.map((request) => [request.id, request])).values()) {
								await innerTx.purchaseRequest.update({
									where: { id: pr.id },
									data: {
										ActionHistory: { connect: { id: pr.nextActionId } },
										NextAction: {
											upsert: {
												update: {
													requestedAction: PurchasingAction.WaitingForManualAction,
													errorNote:
														'Rolled back transaction detected. Please check the transaction and manually resolve the issue.',
													errorType: PurchaseErrorType.Unknown,
												},
												create: {
													requestedAction: PurchasingAction.WaitingForManualAction,
													errorNote:
														'Rolled back transaction detected. Please check the transaction and manually resolve the issue.',
													errorType: PurchaseErrorType.Unknown,
												},
											},
										},
									},
								});
							}
						},
						{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
					),
				{ label: 'tx-sync-rollback' },
			);
		}
	}
}
