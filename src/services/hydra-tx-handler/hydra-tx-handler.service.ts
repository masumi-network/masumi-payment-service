import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { TransactionStatus, OnChainState, PaymentAction, PurchasingAction, Prisma } from '@/generated/prisma/client';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { convertNewPaymentActionAndError, convertNewPurchasingActionAndError } from '@/utils/logic/state-transitions';
import { CONSTANTS } from '@masumi/payment-core/config';
import { deriveExpectedOnChainState } from './derive-state';

const mutex = new Mutex();

export async function checkHydraTransactions() {
	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch (error) {
		logger.info('[HydraTxHandler] Mutex timeout when locking', { error });
		return;
	}

	try {
		const connectionManager = getHydraConnectionManager();

		const pendingTxs = await prisma.transaction.findMany({
			where: {
				layer: 'L2',
				status: TransactionStatus.Pending,
				txHash: { not: null },
				hydraHeadId: { not: null },
			},
			include: {
				PaymentRequestCurrent: {
					include: { NextAction: true },
				},
				PurchaseRequestCurrent: {
					include: { NextAction: true },
				},
				BlocksWallet: true,
			},
		});

		if (pendingTxs.length === 0) {
			return;
		}

		logger.info(`[HydraTxHandler] Checking ${pendingTxs.length} pending L2 transactions`);

		for (const tx of pendingTxs) {
			try {
				if (!tx.hydraHeadId) {
					logger.warn(`[HydraTxHandler] No hydra head ID for transaction ${tx.id}, skipping`);
					continue;
				}

				const node = connectionManager.getNode(tx.hydraHeadId);
				if (!node) {
					logger.warn(`[HydraTxHandler] No active connection for head ${tx.hydraHeadId}, skipping tx ${tx.id}`);
					continue;
				}

				if (!tx.txHash) {
					logger.warn(`[HydraTxHandler] No tx hash for transaction ${tx.id}, skipping`);
					continue;
				}

				const confirmed = node.isTxConfirmed(tx.txHash);
				if (!confirmed) {
					continue;
				}

				logger.info(`[HydraTxHandler] L2 transaction ${tx.txHash} confirmed in head ${tx.hydraHeadId}`);

				await confirmHydraTransaction(tx);
			} catch (error) {
				logger.error(`[HydraTxHandler] Error processing L2 tx ${tx.id}`, { error });
			}
		}
	} catch (error) {
		logger.error('[HydraTxHandler] Error checking hydra transactions', { error });
	} finally {
		release();
	}
}

async function confirmHydraTransaction(tx: {
	id: string;
	BlocksWallet: { id: string } | null;
	PaymentRequestCurrent: Array<{
		id: string;
		nextActionId: string;
		onChainState: OnChainState | null;
		NextAction: { requestedAction: PaymentAction };
	}>;
	PurchaseRequestCurrent: Array<{
		id: string;
		nextActionId: string;
		onChainState: OnChainState | null;
		NextAction: { requestedAction: PurchasingAction };
	}>;
}) {
	const paymentUpdates = tx.PaymentRequestCurrent.flatMap((paymentRequest) => {
		const currentAction = paymentRequest.NextAction.requestedAction;
		const newOnChainState = deriveExpectedOnChainState(currentAction, paymentRequest.onChainState);
		if (!newOnChainState) {
			logger.warn(`[HydraTxHandler] Cannot derive expected state for payment action ${currentAction}`);
			return [];
		}
		return [
			{
				request: paymentRequest,
				newOnChainState,
				newAction: convertNewPaymentActionAndError(currentAction, newOnChainState),
			},
		];
	});

	const purchaseUpdates = tx.PurchaseRequestCurrent.flatMap((purchaseRequest) => {
		const currentAction = purchaseRequest.NextAction.requestedAction;
		const newOnChainState = deriveExpectedOnChainState(currentAction, purchaseRequest.onChainState);
		if (!newOnChainState) {
			logger.warn(`[HydraTxHandler] Cannot derive expected state for purchase action ${currentAction}`);
			return [];
		}
		return [
			{
				request: purchaseRequest,
				newOnChainState,
				newAction: convertNewPurchasingActionAndError(currentAction, newOnChainState),
			},
		];
	});

	const representativeUpdate = purchaseUpdates[0] ?? paymentUpdates[0];
	if (!representativeUpdate) {
		return;
	}

	await prisma.$transaction(
		async (prisma) => {
			const freshTx = await prisma.transaction.findUnique({ where: { id: tx.id } });
			if (freshTx?.status !== TransactionStatus.Pending) return;

			await prisma.transaction.update({
				where: { id: tx.id },
				data: {
					status: TransactionStatus.Confirmed,
					previousOnChainState: representativeUpdate.request.onChainState,
					newOnChainState: representativeUpdate.newOnChainState,
					...(tx.BlocksWallet ? { BlocksWallet: { disconnect: true } } : {}),
				},
			});

			for (const update of paymentUpdates) {
				await prisma.paymentRequest.update({
					where: { id: update.request.id },
					data: {
						onChainState: update.newOnChainState,
						ActionHistory: { connect: { id: update.request.nextActionId } },
						NextAction: {
							create: {
								requestedAction: update.newAction.action,
								errorNote: update.newAction.errorNote,
								errorType: update.newAction.errorType,
							},
						},
					},
				});
			}

			for (const update of purchaseUpdates) {
				await prisma.purchaseRequest.update({
					where: { id: update.request.id },
					data: {
						onChainState: update.newOnChainState,
						ActionHistory: { connect: { id: update.request.nextActionId } },
						NextAction: {
							create: {
								requestedAction: update.newAction.action,
								errorNote: update.newAction.errorNote,
								errorType: update.newAction.errorType,
							},
						},
					},
				});
			}

			if (tx.BlocksWallet) {
				await prisma.hotWallet.update({
					where: { id: tx.BlocksWallet.id, deletedAt: null },
					data: { lockedAt: null },
				});
			}
		},
		{
			isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
			timeout: CONSTANTS.TRANSACTION_WAIT.SERIALIZABLE,
			maxWait: CONSTANTS.TRANSACTION_WAIT.SERIALIZABLE,
		},
	);
}
