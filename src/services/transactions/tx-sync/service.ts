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
import {
	markCanonicalRolledBackQuarantines,
	QUARANTINE_CHAIN_ORDER,
	quarantineTransaction,
	settleCanonicalRolledBackQuarantines,
} from './quarantine';
import {
	createPaymentSourceTxSyncFence,
	fencePaymentSourceTxSyncVersion,
	isTxSyncFenceLostError,
	TxSyncBeforeWrite,
} from './quarantine/fenced-write';
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
				await unlockPaymentSources(paymentContracts);
			}
		} catch (error) {
			logger.error('Error checking latest transactions', { error: error });
		}
	});
}

export async function processPaymentSource(
	paymentContract: PaymentSourceWithConfig,
	maxParallelTransactionsExtendedLookup: number,
) {
	const blockfrost = createApiClient(paymentContract.network, paymentContract.PaymentSourceConfig.rpcProviderApiKey);
	let latestIdentifier = paymentContract.lastIdentifierChecked;
	let txSyncFenceVersion = paymentContract.txSyncFenceVersion;
	const advanceFenceVersion = (nextVersion: number) => {
		txSyncFenceVersion = nextVersion;
		paymentContract.txSyncFenceVersion = nextVersion;
	};
	const quarantineWithFence = async (
		params: Omit<Parameters<typeof quarantineTransaction>[0], 'expectedFenceVersion'>,
	) => {
		advanceFenceVersion(await quarantineTransaction({ ...params, expectedFenceVersion: txSyncFenceVersion }));
	};

	// A prior scanner may have committed the durable rollback marker and then
	// crashed before settlement. Recover that barrier before trusting the cursor:
	// if the same signed hash was re-included, an old cursor would otherwise hide
	// it as already processed. Rewind to null for a conservative full rescan.
	const pendingCanonicalRollbacks = await prisma.txSyncQuarantine.findMany({
		where: {
			paymentSourceId: paymentContract.id,
			resolvedAt: null,
			canonicalRollbackAt: { not: null },
		},
		select: { txHash: true },
	});
	if (pendingCanonicalRollbacks.length > 0) {
		const pendingTxHashes = pendingCanonicalRollbacks.map((entry) => entry.txHash);
		const rollbackFence = createPaymentSourceTxSyncFence(paymentContract.id, txSyncFenceVersion);
		await updateRolledBackTransaction(
			pendingTxHashes.map((txHash) => ({ tx_hash: txHash })),
			rollbackFence,
		);
		await settleCanonicalRolledBackQuarantines(
			{
				paymentSourceId: paymentContract.id,
				txHashes: pendingTxHashes,
				txSyncFenceVersion,
			},
			null,
		);
		latestIdentifier = null;
	}

	const { latestTx, rolledBackTx, rollbackAnchor } = await getTxsFromCardanoAfterSpecificTx(
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
		const marker = await markCanonicalRolledBackQuarantines({
			paymentSourceId: paymentContract.id,
			txHashes: rolledBackTx.map((tx) => tx.tx_hash),
			expectedFenceVersion: txSyncFenceVersion,
		});
		advanceFenceVersion(marker.txSyncFenceVersion);
		const rollbackFence = createPaymentSourceTxSyncFence(paymentContract.id, txSyncFenceVersion);
		await updateRolledBackTransaction(rolledBackTx, rollbackFence);
		// Settlement and rewind commit atomically after every rollback business
		// mutation succeeds.
		await settleCanonicalRolledBackQuarantines(marker, rollbackAnchor);
		latestIdentifier = rollbackAnchor;
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

	const txDataByHash = new Map(txData.map((tx) => [tx.tx.tx_hash, tx]));
	const failureByHash = new Map(failures.map((failure) => [failure.txHash, failure]));
	const orderedLatestTx = [...latestTx].sort((left, right) => {
		if (left.block_height !== right.block_height) return left.block_height - right.block_height;
		return left.tx_index - right.tx_index;
	});

	// A pending row from an earlier tick is still a predecessor even when its
	// backoff has not elapsed or it needs an operator. Without this check, the
	// next scanner tick starts after the quarantined checkpoint and applies its
	// descendants out of order.
	const unresolvedPredecessor = await prisma.txSyncQuarantine.findFirst({
		where: { paymentSourceId: paymentContract.id, resolvedAt: null },
		orderBy: QUARANTINE_CHAIN_ORDER,
		select: { txHash: true },
	});
	let blockingTxHash = unresolvedPredecessor?.txHash ?? null;

	// Walk the enumeration in strict chain order. Once one tx is quarantined,
	// every descendant is durably queued instead of being applied ahead of it.
	// The checkpoint advances only after each row has either been applied or
	// recorded, so a failed quarantine write leaves that row visible next tick.
	for (const enumeratedTx of orderedLatestTx) {
		const txHash = enumeratedTx.tx_hash;
		const failure = failureByHash.get(txHash);
		const tx = txDataByHash.get(txHash);

		if (blockingTxHash != null) {
			if (failure != null) {
				await quarantineWithFence({
					paymentSourceId: paymentContract.id,
					txHash,
					blockHeight: failure.blockHeight,
					txIndex: failure.txIndex,
					reason: TxSyncQuarantineReason.ExtendedLookupFailed,
					error: failure.error,
				});
			} else if (txHash !== blockingTxHash) {
				await quarantineWithFence({
					paymentSourceId: paymentContract.id,
					txHash,
					blockHeight: tx?.blockHeight ?? enumeratedTx.block_height,
					txIndex: tx?.txIndex ?? enumeratedTx.tx_index,
					reason: TxSyncQuarantineReason.PredecessorPending,
					error: new Error(`Deferred until predecessor ${blockingTxHash} is resolved`),
				});
			}

			await updateSyncCheckpoint(paymentContract, txHash, latestIdentifier, txSyncFenceVersion);
			latestIdentifier = txHash;
			continue;
		}

		if (failure != null || tx == null) {
			await quarantineWithFence({
				paymentSourceId: paymentContract.id,
				txHash,
				blockHeight: failure?.blockHeight ?? enumeratedTx.block_height,
				txIndex: failure?.txIndex ?? enumeratedTx.tx_index,
				reason: TxSyncQuarantineReason.ExtendedLookupFailed,
				error: failure?.error ?? new Error('Extended lookup returned neither data nor a failure'),
			});
			blockingTxHash = txHash;
		} else {
			// A healthy shallow transaction is not quarantined merely because a
			// later lookup failed. Keep the checkpoint before it; the entire suffix
			// will be enumerated again after it reaches confirmation depth.
			if (tx.block.confirmations < CONFIG.BLOCK_CONFIRMATIONS_THRESHOLD) {
				break;
			}

			try {
				await processTransactionData(tx, paymentContract, blockfrost, {
					beforeWrite: createPaymentSourceTxSyncFence(paymentContract.id, txSyncFenceVersion),
				});
			} catch (error) {
				if (isTxSyncFenceLostError(error)) throw error;
				await quarantineWithFence({
					paymentSourceId: paymentContract.id,
					txHash,
					blockHeight: tx.blockHeight,
					txIndex: tx.txIndex,
					reason: TxSyncQuarantineReason.ProcessingFailed,
					error,
				});
				blockingTxHash = txHash;
			}
		}

		await updateSyncCheckpoint(paymentContract, txHash, latestIdentifier, txSyncFenceVersion);
		latestIdentifier = txHash;
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
	options: { beforeWrite?: TxSyncBeforeWrite } = {},
) {
	const extractedData = extractOnChainTransactionData(tx, paymentContract);

	if (extractedData.type == 'Invalid') {
		// KNOWN RESIDUAL SILENT PATH. 'Invalid' covers txs at the contract
		// address that do not fit the expected 1-input/1-redeemer/1-output
		// interaction shape. Most are spam or foreign txs and skipping is
		// correct — but a parser gap (a tx shape this version cannot read)
		// lands here too and is skipped WITHOUT quarantine, advancing the
		// checkpoint past it. Quarantining these would let spam pile up
		// indefinitely, so the trade-off is deliberate; if a legitimate tx is
		// ever classified Invalid, this log line is the only trace.
		logger.info('Skipping invalid tx: ', tx.tx.tx_hash, extractedData.error);
		return;
	} else if (extractedData.type == 'Initial') {
		await updateInitialTransactions(
			extractedData.valueOutputs,
			paymentContract,
			tx,
			paymentContract.PaymentSourceConfig.rpcProviderApiKey,
			options.beforeWrite,
		);
	} else if (extractedData.type == 'Transaction') {
		// Multi-redeemer batch txs produce N entries — one per script input
		// consumed in this tx. Each entry maps to exactly one PaymentRequest
		// / PurchaseRequest row via its decoded datum's blockchainIdentifier.
		// Process them sequentially: each updateTransaction is independent at
		// the row level so order is irrelevant, but the sequential await
		// keeps the per-entry Prisma transactions from racing each other.
		for (const entry of extractedData.entries) {
			await updateTransaction(paymentContract, entry, blockfrost, tx, options.beforeWrite);
		}
	}
}
async function updateSyncCheckpoint(
	paymentContract: PaymentSourceWithConfig,
	currentTxHash: string | null,
	previousTxHash: string | null,
	txSyncFenceVersion: number,
	shouldPersistPreviousIdentifier: boolean = true,
) {
	await withSerializableSlotRetry(
		() =>
			prisma.$transaction(
				async (txdb) => {
					await fencePaymentSourceTxSyncVersion(txdb, paymentContract.id, txSyncFenceVersion);
					await txdb.paymentSource.update({
						where: { id: paymentContract.id, deletedAt: null },
						data: { lastIdentifierChecked: currentTxHash },
					});

					if (shouldPersistPreviousIdentifier && previousTxHash != null) {
						await txdb.paymentSourceIdentifiers.upsert({
							where: { txHash: previousTxHash },
							update: { txHash: previousTxHash },
							create: { txHash: previousTxHash, paymentSourceId: paymentContract.id },
						});
					}
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
					timeout: 30_000,
					maxWait: 30_000,
				},
			),
		{ label: 'tx-sync-checkpoint' },
	);
}

export async function unlockPaymentSources(paymentContracts: PaymentSourceWithConfig[]) {
	for (const paymentContract of paymentContracts) {
		try {
			const released = await prisma.paymentSource.updateMany({
				where: {
					id: paymentContract.id,
					syncInProgress: true,
					txSyncFenceVersion: paymentContract.txSyncFenceVersion,
				},
				data: { syncInProgress: false },
			});
			if (released.count !== 1) {
				logger.warn('Tx-sync source lock was already replaced; stale scanner did not unlock its successor', {
					paymentSourceId: paymentContract.id,
					txSyncFenceVersion: paymentContract.txSyncFenceVersion,
				});
			}
		} catch (error) {
			logger.error('Error unlocking payment source', { paymentSourceId: paymentContract.id, error });
		}
	}
}

export async function queryAndLockPaymentSourcesForSync() {
	// Gate Serializable $transaction through the shared semaphore so the pg
	// connection pool isn't exhausted under scheduler fan-out. See
	// `src/utils/db/serializable-semaphore.ts`.
	return await withSerializableSlotRetry(
		() =>
			prisma.$transaction(
				async (txdb) => {
					const staleBefore = new Date(Date.now() - CONFIG.SYNC_LOCK_TIMEOUT_INTERVAL);
					const paymentContracts = await txdb.paymentSource.findMany({
						where: {
							deletedAt: null,
							disableSyncAt: null,
							OR: [
								{ syncInProgress: false },
								{
									syncInProgress: true,
									updatedAt: { lte: staleBefore },
								},
							],
						},
						include: {
							PaymentSourceConfig: true,
						},
					});
					const acquired: PaymentSourceWithConfig[] = [];
					for (const paymentContract of paymentContracts) {
						const locked = await txdb.paymentSource.updateMany({
							where: {
								id: paymentContract.id,
								deletedAt: null,
								disableSyncAt: null,
								txSyncFenceVersion: paymentContract.txSyncFenceVersion,
								OR: [{ syncInProgress: false }, { syncInProgress: true, updatedAt: { lte: staleBefore } }],
							},
							data: { syncInProgress: true, txSyncFenceVersion: { increment: 1 } },
						});
						if (locked.count === 1) {
							acquired.push({
								...paymentContract,
								syncInProgress: true,
								txSyncFenceVersion: paymentContract.txSyncFenceVersion + 1,
							});
						}
					}

					if (acquired.length === 0) {
						logger.warn(
							'No payment contracts found, skipping update. It could be that another instance is already syncing',
						);
						return null;
					}
					return acquired;
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
