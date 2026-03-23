import { prisma } from '@/utils/db';
import { logger } from '@/utils/logger';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { TransactionStatus, OnChainState, PaymentAction, PurchasingAction, Prisma } from '@/generated/prisma/client';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { convertNewPaymentActionAndError, convertNewPurchasingActionAndError } from '@/utils/logic/state-transitions';
import { CONSTANTS } from '@/utils/config';
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

				if (tx.PaymentRequestCurrent) {
					await confirmPaymentTransaction(tx, tx.PaymentRequestCurrent);
				}

				if (tx.PurchaseRequestCurrent) {
					await confirmPurchaseTransaction(tx, tx.PurchaseRequestCurrent);
				}
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

async function confirmPaymentTransaction(
	tx: {
		id: string;
		BlocksWallet: { id: string } | null;
	},
	paymentRequest: {
		id: string;
		nextActionId: string;
		onChainState: OnChainState | null;
		NextAction: { requestedAction: PaymentAction };
	},
) {
	const currentAction = paymentRequest.NextAction.requestedAction;
	const newOnChainState = deriveExpectedOnChainState(currentAction, paymentRequest.onChainState);

	if (!newOnChainState) {
		logger.warn(`[HydraTxHandler] Cannot derive expected state for payment action ${currentAction}`);
		return;
	}

	const newAction = convertNewPaymentActionAndError(currentAction, newOnChainState);

	await prisma.$transaction(
		async (prisma) => {
			await prisma.transaction.update({
				where: { id: tx.id },
				data: {
					status: TransactionStatus.Confirmed,
					previousOnChainState: paymentRequest.onChainState,
					newOnChainState,
					...(tx.BlocksWallet ? { BlocksWallet: { disconnect: true } } : {}),
				},
			});

			await prisma.paymentRequest.update({
				where: { id: paymentRequest.id },
				data: {
					onChainState: newOnChainState,
					ActionHistory: { connect: { id: paymentRequest.nextActionId } },
					NextAction: {
						create: {
							requestedAction: newAction.action,
							errorNote: newAction.errorNote,
							errorType: newAction.errorType,
						},
					},
				},
			});

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

async function confirmPurchaseTransaction(
	tx: {
		id: string;
		BlocksWallet: { id: string } | null;
	},
	purchaseRequest: {
		id: string;
		nextActionId: string;
		onChainState: OnChainState | null;
		NextAction: { requestedAction: PurchasingAction };
	},
) {
	const currentAction = purchaseRequest.NextAction.requestedAction;
	const newOnChainState = deriveExpectedOnChainState(currentAction, purchaseRequest.onChainState);

	if (!newOnChainState) {
		logger.warn(`[HydraTxHandler] Cannot derive expected state for purchase action ${currentAction}`);
		return;
	}

	const newAction = convertNewPurchasingActionAndError(currentAction, newOnChainState);

	await prisma.$transaction(
		async (prisma) => {
			await prisma.transaction.update({
				where: { id: tx.id },
				data: {
					status: TransactionStatus.Confirmed,
					previousOnChainState: purchaseRequest.onChainState,
					newOnChainState,
					...(tx.BlocksWallet ? { BlocksWallet: { disconnect: true } } : {}),
				},
			});

			await prisma.purchaseRequest.update({
				where: { id: purchaseRequest.id },
				data: {
					onChainState: newOnChainState,
					ActionHistory: { connect: { id: purchaseRequest.nextActionId } },
					NextAction: {
						create: {
							requestedAction: newAction.action,
							errorNote: newAction.errorNote,
							errorType: newAction.errorType,
						},
					},
				},
			});

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
