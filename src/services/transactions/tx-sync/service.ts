import {
	OnChainState,
	PaymentAction,
	PaymentErrorType,
	PaymentSource,
	PaymentSourceConfig,
	Prisma,
	PurchaseErrorType,
	PurchasingAction,
	TxSyncQuarantineReason,
} from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Mutex } from 'async-mutex';
import { CONFIG, CONSTANTS } from '@masumi/payment-core/config';
import { extractOnChainTransactionData } from './util';
import { getExtendedTxInformation, getTxsFromCardanoAfterSpecificTx } from './blockchain';
import { quarantineTransaction } from './quarantine';
import {
	updateInitialTransactions,
	updateRolledBackTransaction,
	updateTransaction,
	UpdateTransactionInput,
} from './tx';
import { createApiClient, withJobLock } from '@/services/shared';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { withSerializableSlotRetry } from '@masumi/payment-core/serializable-semaphore';

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

	// Process rollbacks BEFORE the empty-latestTx early return. The most common
	// reorg shape is the tip tx being rolled back with no replacement landed yet
	// (latestTx == []); returning first would leave DB rows Confirmed/Withdrawn
	// for a tx that no longer exists on chain and re-detect the same rollback
	// every tick without ever applying it.
	if (rolledBackTx.length > 0) {
		logger.info('Rolled back transactions found for payment contract', {
			paymentContractAddress: paymentContract.smartContractAddress,
		});
		await updateRolledBackTransaction(rolledBackTx);
	}

	if (latestTx.length == 0) {
		logger.info('No new transactions found for payment contract', {
			paymentContractAddress: paymentContract.smartContractAddress,
		});
		return;
	}

	const { txData, failures } = await getExtendedTxInformation(
		latestTx,
		blockfrost,
		maxParallelTransactionsExtendedLookup,
	);

	// Record lookup failures BEFORE processing anything. The checkpoint is about
	// to advance past these transactions, so if quarantining fails we must not
	// start advancing at all — quarantineTransaction throws for exactly that
	// reason and we let it propagate.
	for (const failure of failures) {
		await quarantineTransaction({
			paymentSourceId: paymentContract.id,
			txHash: failure.txHash,
			blockHeight: failure.blockHeight,
			txIndex: failure.txIndex,
			reason: TxSyncQuarantineReason.ExtendedLookupFailed,
			error: failure.error,
		});
	}

	for (const tx of txData) {
		if (tx.block.confirmations < CONFIG.BLOCK_CONFIRMATIONS_THRESHOLD) {
			break;
		}

		try {
			await processTransactionData(tx, paymentContract, blockfrost);
		} catch (error) {
			// One transaction that cannot be processed must not stall every later
			// transaction for this payment source, and it must not vanish either.
			// Quarantine it and carry on; the reconciler owns the retry.
			//
			// If the quarantine write itself fails we deliberately do NOT advance
			// the checkpoint — rethrowing halts this tick and the scanner will see
			// the transaction again next time.
			await quarantineTransaction({
				paymentSourceId: paymentContract.id,
				txHash: tx.tx.tx_hash,
				blockHeight: tx.blockHeight,
				txIndex: tx.txIndex,
				reason: TxSyncQuarantineReason.ProcessingFailed,
				error,
			});
		}

		await updateSyncCheckpoint(paymentContract, tx.tx.tx_hash, latestIdentifier);
		latestIdentifier = tx.tx.tx_hash;
	}
}

// Shared timeout predicate. A request is "timed out" when:
//   - onChainState is still null (buyer never locked funds on chain), AND
//   - payByTime has passed by more than 5 minutes, AND
//   - the request is either still in its initial waiting state
//     (FundsLockingRequested / WaitingForExternalAction) OR has already
//     been parked in an error state.
//
// We use a 5-minute grace after payByTime to avoid racing late blockchain
// confirmations: a buyer's lock tx may have been broadcast right at the
// deadline and is still propagating to Blockfrost. The grace gives tx-sync
// a chance to observe it before we declare the request dead.
const TIMEOUT_GRACE_MS = 1000 * 60 * 5;

async function invalidateTimedOutPurchaseRequests() {
	const cutoff = Date.now() - TIMEOUT_GRACE_MS;
	// Per-row update so we can also advance NextAction (a relation —
	// `updateMany` can only touch scalars). Previously we only flipped
	// `onChainState` and left NextAction stuck at FundsLockingRequested,
	// which made the row look "still pending" in dashboards and to
	// operators reading the request audit trail. Batch-payments queries
	// already filter `onChainState: null` so they never re-pick these
	// rows — but the operator-visible state was misleading.
	const timedOut = await prisma.purchaseRequest.findMany({
		where: {
			OR: [
				{
					onChainState: null,
					NextAction: {
						requestedAction: PurchasingAction.FundsLockingRequested,
					},
					payByTime: { lt: cutoff },
				},
				{
					onChainState: null,
					NextAction: {
						errorType: { not: null },
					},
					payByTime: { lt: cutoff },
				},
			],
		},
		select: { id: true, nextActionId: true, payByTime: true },
	});

	for (const row of timedOut) {
		try {
			await retryOnSerializationConflict(
				() =>
					prisma.purchaseRequest.update({
						where: { id: row.id, nextActionId: row.nextActionId },
						data: {
							onChainState: OnChainState.FundsOrDatumInvalid,
							ActionHistory: { connect: { id: row.nextActionId } },
							NextAction: {
								create: {
									requestedAction: PurchasingAction.WaitingForManualAction,
									errorType: PurchaseErrorType.Unknown,
									errorNote: `Purchase request payByTime (${row.payByTime?.toString() ?? 'unset'}) passed without on-chain lock; no FundsLocked tx observed within ${TIMEOUT_GRACE_MS / 1000}s grace.`,
								},
							},
						},
					}),
				{ label: 'invalidate-timed-out-purchase' },
			);
		} catch (err) {
			// Row may have advanced concurrently (tx-sync observed a late
			// chain confirmation, batch service resubmitted, etc.) — the
			// `nextActionId` guard rejects with P2025 in that case. Log
			// and skip; the row is no longer ours to invalidate.
			logger.warn('invalidateTimedOutPurchaseRequests: per-row update skipped (concurrent advance)', {
				purchaseRequestId: row.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	logger.info('Failed timed out purchase requests', {
		count: timedOut.length,
		ids: timedOut.map((r) => r.id),
	});
}

async function invalidateTimedOutPaymentRequests() {
	const cutoff = Date.now() - TIMEOUT_GRACE_MS;
	const timedOut = await prisma.paymentRequest.findMany({
		where: {
			OR: [
				{
					onChainState: null,
					NextAction: {
						requestedAction: PaymentAction.WaitingForExternalAction,
					},
					payByTime: { lt: cutoff },
				},
				{
					onChainState: null,
					NextAction: {
						errorType: { not: null },
					},
					payByTime: { lt: cutoff },
				},
			],
		},
		select: { id: true, nextActionId: true, payByTime: true },
	});

	for (const row of timedOut) {
		try {
			await retryOnSerializationConflict(
				() =>
					prisma.paymentRequest.update({
						where: { id: row.id, nextActionId: row.nextActionId },
						data: {
							onChainState: OnChainState.FundsOrDatumInvalid,
							ActionHistory: { connect: { id: row.nextActionId } },
							NextAction: {
								create: {
									requestedAction: PaymentAction.WaitingForManualAction,
									errorType: PaymentErrorType.Unknown,
									errorNote: `Payment request payByTime (${row.payByTime?.toString() ?? 'unset'}) passed without on-chain lock; no FundsLocked tx observed within ${TIMEOUT_GRACE_MS / 1000}s grace.`,
								},
							},
						},
					}),
				{ label: 'invalidate-timed-out-payment' },
			);
		} catch (err) {
			logger.warn('invalidateTimedOutPaymentRequests: per-row update skipped (concurrent advance)', {
				paymentRequestId: row.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	logger.info('Failed timed out payment requests', {
		count: timedOut.length,
		ids: timedOut.map((r) => r.id),
	});
}

/**
 * Exported so the quarantine reconciler retries transactions through the exact
 * same path the scanner uses — a divergent retry path would be a second
 * implementation to keep in sync, and drift there is invisible until it
 * matters.
 */
export async function processTransactionData(
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
	// Gate Serializable $transaction through the shared semaphore so the pg
	// connection pool isn't exhausted under scheduler fan-out. See
	// `src/utils/db/serializable-semaphore.ts`.
	return await withSerializableSlotRetry(
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
