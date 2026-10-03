import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { TransactionStatus } from '@/generated/prisma/client';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';

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

				await connectionManager.handleTxConfirmed(
					tx.hydraHeadId,
					tx.txHash,
					node.getConfirmedTransaction(tx.txHash) ?? undefined,
				);
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
