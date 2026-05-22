import {
	OnChainState,
	PaymentAction,
	PaymentSource,
	PaymentSourceConfig,
	Prisma,
	PurchasingAction,
} from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Mutex } from 'async-mutex';
import { CONFIG, CONSTANTS } from '@masumi/payment-core/config';
import { extractOnChainTransactionData } from './util';
import { getExtendedTxInformation, getTxsFromCardanoAfterSpecificTx } from './blockchain';
import {
	updateInitialTransactions,
	updateRolledBackTransaction,
	updateTransaction,
	UpdateTransactionInput,
} from './tx';
import { createApiClient, withJobLock } from '@/services/shared';
import { retryOnSerializationConflict } from '@/utils/db/retry';

type PaymentSourceWithConfig = PaymentSource & {
	PaymentSourceConfig: PaymentSourceConfig;
};

const mutex = new Mutex();

export async function checkLatestTransactions(
	{
		maxParallelTransactionsExtendedLookup:
			maxParallelTransactionsExtendedLookup = CONSTANTS.DEFAULT_MAX_PARALLEL_TRANSACTIONS_EXTENDED_LOOKUP,
	}: { maxParallelTransactionsExtendedLookup?: number } = {
		maxParallelTransactionsExtendedLookup: CONSTANTS.DEFAULT_MAX_PARALLEL_TRANSACTIONS_EXTENDED_LOOKUP,
	},
) {
	await withJobLock(mutex, 'cardano_tx_sync', async () => {
		try {
			await invalidateTimedOutPurchaseRequests();
			await invalidateTimedOutPaymentRequests();
			const paymentContracts = await queryAndLockPaymentSourcesForSync();

			if (paymentContracts == null) return;
			try {
				const results = await Promise.allSettled(
					paymentContracts.map((paymentContract) =>
						processPaymentSource(paymentContract, maxParallelTransactionsExtendedLookup),
					),
				);

				const failedResults = results.filter((x) => x.status == 'rejected');
				if (failedResults.length > 0) {
					logger.error('Error updating tx data', {
						error: failedResults,
						paymentContract: paymentContracts,
					});
				}
			} catch (error) {
				logger.error('Error checking latest transactions', { error: error });
			} finally {
				await unlockPaymentSources(paymentContracts.map((x) => x.id));
			}
		} catch (error) {
			logger.error('Error checking latest transactions', { error: error });
		}
	});
}

async function processPaymentSource(
	paymentContract: PaymentSourceWithConfig,
	maxParallelTransactionsExtendedLookup: number,
) {
	const blockfrost = createApiClient(paymentContract.network, paymentContract.PaymentSourceConfig.rpcProviderApiKey);
	let latestIdentifier = paymentContract.lastIdentifierChecked;

	const { latestTx, rolledBackTx } = await getTxsFromCardanoAfterSpecificTx(
		blockfrost,
		paymentContract,
		latestIdentifier,
	);

	if (latestTx.length == 0) {
		logger.info('No new transactions found for payment contract', {
			paymentContractAddress: paymentContract.smartContractAddress,
		});
		return;
	}

	if (rolledBackTx.length > 0) {
		logger.info('Rolled back transactions found for payment contract', {
			paymentContractAddress: paymentContract.smartContractAddress,
		});
		await updateRolledBackTransaction(rolledBackTx);
	}

	const txData = await getExtendedTxInformation(latestTx, blockfrost, maxParallelTransactionsExtendedLookup);

	for (const tx of txData) {
		if (tx.block.confirmations < CONFIG.BLOCK_CONFIRMATIONS_THRESHOLD) {
			break;
		}

		try {
			await processTransactionData(tx, paymentContract, blockfrost);
			await updateSyncCheckpoint(paymentContract, tx.tx.tx_hash, latestIdentifier);
			latestIdentifier = tx.tx.tx_hash;
		} catch (error) {
			//If the error persists this will prevent a further sync
			logger.error('-----------SYNC FAILED TO CONTINUE: Error updating sync checkpoint-----------');
			logger.error('SYNC FAILED TO CONTINUE: Error processing transaction', {
				error: error,
				tx: tx,
			});
			throw error;
		}
	}
}

async function invalidateTimedOutPurchaseRequests() {
	const failTimedOutPurchaseRequests = await prisma.purchaseRequest.updateMany({
		where: {
			OR: [
				{
					onChainState: null,
					NextAction: {
						requestedAction: PurchasingAction.FundsLockingRequested,
					},
					payByTime: { lt: Date.now() - 1000 * 60 * 5 },
				},
				{
					onChainState: null,
					NextAction: {
						errorType: { not: null },
					},
					payByTime: { lt: Date.now() - 1000 * 60 * 5 },
				},
			],
		},
		data: {
			onChainState: OnChainState.FundsOrDatumInvalid,
		},
	});
	logger.info('Failed timed out purchase requests', {
		failTimedOutPurchaseRequests: failTimedOutPurchaseRequests,
	});
}

async function invalidateTimedOutPaymentRequests() {
	const failTimedOutPaymentRequests = await prisma.paymentRequest.updateMany({
		where: {
			OR: [
				{
					onChainState: null,
					NextAction: {
						requestedAction: PaymentAction.WaitingForExternalAction,
					},
					payByTime: { lt: Date.now() - 1000 * 60 * 5 },
				},
				{
					onChainState: null,
					NextAction: {
						errorType: { not: null },
					},
					payByTime: { lt: Date.now() - 1000 * 60 * 5 },
				},
			],
		},
		data: {
			onChainState: OnChainState.FundsOrDatumInvalid,
		},
	});
	logger.info('Failed timed out payment requests', {
		failTimedOutPaymentRequests: failTimedOutPaymentRequests,
	});
}

async function processTransactionData(
	tx: UpdateTransactionInput,
	paymentContract: PaymentSourceWithConfig,
	blockfrost: BlockFrostAPI,
) {
	const extractedData = extractOnChainTransactionData(tx, paymentContract);

	if (extractedData.type == 'Invalid') {
		logger.info('Skipping invalid tx: ', tx.tx.tx_hash, extractedData.error);
		return;
	} else if (extractedData.type == 'Initial') {
		await updateInitialTransactions(
			extractedData.valueOutputs,
			paymentContract,
			tx,
			paymentContract.PaymentSourceConfig.rpcProviderApiKey,
		);
	} else if (extractedData.type == 'Transaction') {
		// Multi-redeemer batch txs produce N entries — one per script input
		// consumed in this tx. Each entry maps to exactly one PaymentRequest
		// / PurchaseRequest row via its decoded datum's blockchainIdentifier.
		// Process them sequentially: each updateTransaction is independent at
		// the row level so order is irrelevant, but the sequential await
		// keeps the per-entry Prisma transactions from racing each other.
		for (const entry of extractedData.entries) {
			await updateTransaction(paymentContract, entry, blockfrost, tx);
		}
	}
}
async function updateSyncCheckpoint(
	paymentContract: PaymentSourceWithConfig,
	currentTxHash: string,
	previousTxHash: string | null,
) {
	await prisma.paymentSource.update({
		where: { id: paymentContract.id, deletedAt: null },
		data: {
			lastIdentifierChecked: currentTxHash,
		},
	});

	// Separately handle PaymentSourceIdentifiers
	if (previousTxHash != null) {
		await prisma.paymentSourceIdentifiers.upsert({
			where: {
				txHash: previousTxHash,
			},
			update: {
				txHash: previousTxHash,
			},
			create: {
				txHash: previousTxHash,
				paymentSourceId: paymentContract.id,
			},
		});
	}
}

async function unlockPaymentSources(paymentContractIds: string[]) {
	try {
		await prisma.paymentSource.updateMany({
			where: {
				id: { in: paymentContractIds },
			},
			data: { syncInProgress: false },
		});
	} catch (error) {
		logger.error('Error unlocking payment sources', { error: error });
	}
}

async function queryAndLockPaymentSourcesForSync() {
	return await retryOnSerializationConflict(
		() =>
			prisma.$transaction(
				async (prisma) => {
					const paymentContracts = await prisma.paymentSource.findMany({
						where: {
							deletedAt: null,
							disableSyncAt: null,
							OR: [
								{ syncInProgress: false },
								{
									syncInProgress: true,
									updatedAt: {
										lte: new Date(
											Date.now() -
												//3 minutes
												CONFIG.SYNC_LOCK_TIMEOUT_INTERVAL,
										),
									},
								},
							],
						},
						include: {
							PaymentSourceConfig: true,
						},
					});
					if (paymentContracts.length == 0) {
						logger.warn(
							'No payment contracts found, skipping update. It could be that an other instance is already syncing',
						);
						return null;
					}

					await prisma.paymentSource.updateMany({
						where: {
							id: { in: paymentContracts.map((x) => x.id) },
							deletedAt: null,
						},
						data: { syncInProgress: true },
					});
					return paymentContracts.map((x) => {
						return { ...x, syncInProgress: true };
					});
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
					timeout: 30_000,
					maxWait: 30_000,
				},
			),
		{ label: 'tx-sync-query-and-lock-payment-sources' },
	);
}
