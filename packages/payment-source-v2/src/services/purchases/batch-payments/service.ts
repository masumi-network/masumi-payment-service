import {
	HotWallet,
	HotWalletType,
	PaymentSourceType,
	PurchaseErrorType,
	PurchasingAction,
	Prisma,
	TransactionStatus,
} from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { withSerializableSlot } from '@masumi/payment-core/serializable-semaphore';
import { UTxO, resolveTxHash } from '@meshsdk/core';
import type { BlockfrostProvider, MeshWallet } from '@/services/shared';
import { Transaction } from '@/services/shared';
import { logger } from '@masumi/payment-core/logger';
import { generateWalletExtended } from '@/utils/generator/wallet-generator';
import { SmartContractState } from '@/utils/generator/contract-generator';
import { convertNetwork } from '@/utils/converter/network-convert';
import { interpretBlockchainError } from '@masumi/payment-core/blockchain-error-interpreter';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { CONSTANTS } from '@masumi/payment-core/config';
import { calculateMinUtxo, DUMMY_RESULT_HASH } from '@/utils/min-utxo';
import { type BalanceMap, toBalanceMapFromMeshUtxos, walletLowBalanceMonitorService } from '@/services/wallets';
import {
	connectExistingTransaction,
	connectPreviousAction,
	createMeshProvider,
	createNextPurchaseAction,
	createTxWindow,
} from '@/services/shared';
import { createDatumFromBlockchainIdentifierV2 } from '@masumi/payment-source-v2';
import { isDefinitiveNodeRejection } from '@masumi/payment-core/submit-error-classifier';
import { isTransientPreSubmitError } from '@masumi/payment-core/pre-submit-error';
import { WALLET_SPLITTER_LOVELACE } from '../../../builders/batch-helpers';
import { syncMeshCostModelsFromChainV2 } from '../../../utils/mesh-cost-model-sync';
import { withMeshCostModelLock } from '@/utils/mesh-cost-model-sync';

/**
 * --- V2 batch-payments: defensive submit invariant ---
 *
 * Money-safety overrides ergonomic state recovery. This service handles
 * BUYER funding (FundsLockingRequested → FundsLocked) — submitting the same
 * lock twice means double-paying the seller. So the invariant here is:
 *
 *   On ANY ambiguous submitTx outcome (transport error, 5xx, timeout, etc.),
 *   we MUST NOT regress request state back to FundsLockingRequested.
 *   Worst case: the tx already landed on chain. A second attempt would lock
 *   the same buyer's funds twice into the contract.
 *
 * The framework that enforces this:
 *   1. Compute deterministic `intendedTxHash = resolveTxHash(signedTx)`
 *      from the signed body.
 *   2. Persist `intendedTxHash` + `invalidHereafterSlot` to the shared
 *      Transaction row BEFORE calling `submitTx`. If this fails we abort
 *      pre-submit and revert is safe (the tx body has not been broadcast).
 *   3. Call `submitTx`. On throw:
 *        - `isDefinitiveNodeRejection(err) == true`  → safe to revert DB.
 *          The node has demonstrably refused (bad UTxO, signature error,
 *          duplicate-tx rejection, etc.); the tx cannot land on chain.
 *        - `isDefinitiveNodeRejection(err) == false` → AMBIGUOUS. Leave the
 *          Transaction Pending with `intendedTxHash` set. The
 *          `funding-reconciliation` cron resolves by querying the chain for
 *          `intendedTxHash`; if not found after the tx's invalid_hereafter
 *          slot has demonstrably passed, the ledger CAN NEVER accept the
 *          signed body and the row is marked RolledBack — only then is a
 *          retry safe.
 *   4. On node-returned txHash divergence from `intendedTxHash`, treat as
 *      ambiguous and route through reconciliation rather than trusting
 *      either hash.
 *
 * This invariant is the reason every funding-side `submitTx` is wrapped in
 * the structured `BatchPairingOutcome` discriminated union (see below). DO
 * NOT collapse the outcome union back to a boolean; the `submit-ambiguous`
 * arm is a distinct, mandatory state.
 *
 * Other V2 services (collection, refund, etc.) that spend FROM the contract
 * (rather than lock into it) have different trade-offs: a missed collection
 * costs the seller a retry, not double-spend. They currently DO rollback on
 * ambiguous submit. Extending this defensive pattern to those services is
 * tracked as merge-gate item #5.
 */

type PaymentSourceWithWallets = Prisma.PaymentSourceGetPayload<{
	include: {
		PurchaseRequests: {
			include: {
				PaidFunds: true;
				SellerWallet: true;
				SmartContractWallet: true;
				NextAction: true;
				CurrentTransaction: true;
				HotWalletLimit: { select: { id: true } };
			};
		};
		PaymentSourceConfig: true;
		HotWallets: {
			include: {
				Secret: true;
			};
		};
	};
}>;

type PurchaseRequestWithRelations = PaymentSourceWithWallets['PurchaseRequests'][number];

type BatchedRequest = {
	paymentRequest: PurchaseRequestWithRelations;
	overpaidLovelace: bigint;
};

type WalletPairing = {
	wallet: MeshWallet;
	scriptAddress: string;
	walletId: string;
	changeAddress: string;
	collectionAddress: string | null;
	utxos: UTxO[];
	currentBalanceMap: BalanceMap | null;
	batchedRequests: BatchedRequest[];
	// Placeholder Transaction row id created at lock time. The placeholder
	// already carries `BlocksWallet → wallet` so the wallet's
	// pendingTransactionId points at it; executeSpecificBatchPayment updates
	// this row (rather than creating a new sharedTx) since
	// HotWallet.pendingTransactionId @unique permits one connected Tx at a
	// time. Null when the upstream lock-and-query path used a wallet that
	// pre-existed the placeholder convention (defensive fallback for the
	// transitional upgrade window — should not occur in steady state).
	placeholderTransactionId: string | null;
};

async function unlockUnusedPurchasingWallets(candidateWalletIds: string[], usedWalletIds: string[]) {
	const usedWalletIdSet = new Set(usedWalletIds);
	const unusedWalletIds = candidateWalletIds.filter((walletId) => !usedWalletIdSet.has(walletId));
	if (unusedWalletIds.length === 0) {
		return;
	}

	// Each unused wallet still carries the placeholder Transaction created at
	// lock time (BlocksWallet → wallet). Mark the placeholder RolledBack and
	// disconnect it before clearing lockedAt. Without the rollback the
	// placeholder would sit Pending forever and tx-sync / wallet-timeouts
	// would re-discover it every tick; without the disconnect the wallet
	// stays orphan-locked (HotWallet.pendingTransactionId points at a row
	// with no txHash, no progressing batch). Per-wallet write because
	// pendingTransactionId is @unique — can't bulk-disconnect via updateMany.
	await Promise.all(
		unusedWalletIds.map(async (walletId) => {
			const wallet = await prisma.hotWallet.findUnique({
				where: { id: walletId, deletedAt: null },
				select: { pendingTransactionId: true },
			});
			if (wallet?.pendingTransactionId != null) {
				try {
					await prisma.transaction.update({
						where: { id: wallet.pendingTransactionId },
						data: { status: TransactionStatus.RolledBack },
					});
				} catch (rollbackError) {
					logger.warn('batch-payments unused-wallet placeholder rollback failed (non-fatal)', {
						walletId,
						placeholderId: wallet.pendingTransactionId,
						error: rollbackError instanceof Error ? rollbackError.message : rollbackError,
					});
				}
			}
			await prisma.hotWallet.update({
				where: { id: walletId, deletedAt: null },
				data: {
					lockedAt: null,
					PendingTransaction: { disconnect: true },
				},
			});
		}),
	);
}

const mutex = new Mutex();
const MULTI_REQUEST_BATCH_SETTLE_WINDOW_MS = 30_000;
const SINGLE_REQUEST_BATCH_SETTLE_WINDOW_MS = 90_000;

// Lovelace the funds-lock tx consumes once per batch, on top of the per-request
// lock outputs: fee headroom + the WALLET_SPLITTER_LOVELACE self-send that
// executeSpecificBatchPayment always appends (keeps the wallet at >=2 UTxOs for
// the next script tx's collateral). The splitter returns to the wallet, but
// coin-selection must still cover (locks + splitter + fee) at once — so the
// wallet-fit gate MUST reserve it or it greenlights a batch the build rejects
// with "UTxO Balance Insufficient".
const BATCH_TX_LOVELACE_OVERHEAD = CONSTANTS.MIN_TX_FEE_BUFFER_LOVELACE + WALLET_SPLITTER_LOVELACE;

function getBatchSettleWindowMs(requestCount: number) {
	// A singleton is often just the first row of a sequential API burst. Hold it
	// longer so the scheduler does not claim the buyer wallet before sibling
	// purchases arrive; once two or more are visible, keep the normal short
	// settle window so real batches move quickly.
	return requestCount <= 1 ? SINGLE_REQUEST_BATCH_SETTLE_WINDOW_MS : MULTI_REQUEST_BATCH_SETTLE_WINDOW_MS;
}

function getNewestPurchaseRequestCreatedAt(purchaseRequests: PurchaseRequestWithRelations[]) {
	return purchaseRequests.reduce<Date | null>((newestCreatedAt, purchaseRequest) => {
		if (newestCreatedAt == null || purchaseRequest.createdAt > newestCreatedAt) {
			return purchaseRequest.createdAt;
		}
		return newestCreatedAt;
	}, null);
}

/**
 * Structured outcome per wallet-pairing in a batch.
 *
 * Funding txs MUST NOT silently regress request state on ambiguous submit
 * outcomes (a submit that threw AFTER the node accepted the tx will land on
 * chain; reverting requests to FundsLockingRequested risks a second lock).
 * This type makes the per-pairing decision explicit so the outer aggregator
 * can route succeeded / definitively-rejected / ambiguous outcomes
 * differently.
 *
 * See `funding-reconciliation` worker — it resolves `submit-ambiguous` rows
 * by querying the chain for `intendedTxHash` once the tx's
 * `invalidHereafterSlot` has demonstrably passed.
 */
export type BatchPairingOutcome =
	| { status: 'succeeded'; walletId: string; sharedTxId: string; txHash: string; requestIds: string[] }
	| {
			status: 'pre-submit-failed';
			walletId: string;
			sharedTxId: string | null;
			requestIds: string[];
			error: unknown;
	  }
	| {
			status: 'submit-rejected';
			walletId: string;
			sharedTxId: string;
			intendedTxHash: string;
			requestIds: string[];
			error: unknown;
	  }
	| {
			status: 'submit-ambiguous';
			walletId: string;
			sharedTxId: string;
			intendedTxHash: string;
			invalidHereafterSlot: number;
			requestIds: string[];
			error: unknown;
	  }
	| {
			status: 'post-submit-db-failed';
			walletId: string;
			sharedTxId: string;
			txHash: string;
			requestIds: string[];
			error: unknown;
	  };

async function executeSpecificBatchPayment(
	walletPairing: WalletPairing,
	paymentContract: PaymentSourceWithWallets,
	blockchainProvider: BlockfrostProvider,
): Promise<BatchPairingOutcome> {
	const wallet = walletPairing.wallet;
	const walletId = walletPairing.walletId;
	const batchedRequests = walletPairing.batchedRequests;

	//batch payments
	const unsignedTx = new Transaction({
		initiator: wallet,
		fetcher: blockchainProvider,
	}).setMetadata(674, {
		msg: ['Masumi', 'PaymentBatched'],
	});
	logger.info('Batching payments, adding metadata');
	for (const data of batchedRequests) {
		const buyerAddress = wallet.getUsedAddress().toBech32() as string;
		const sellerAddress = data.paymentRequest.SellerWallet.walletAddress;
		const submitResultTime = data.paymentRequest.submitResultTime;
		const unlockTime = data.paymentRequest.unlockTime;
		const externalDisputeUnlockTime = data.paymentRequest.externalDisputeUnlockTime;
		const buyerReturnAddress = data.paymentRequest.buyerReturnAddress ?? walletPairing.collectionAddress;

		if (data.paymentRequest.payByTime == null) {
			throw new Error('Pay by time is null, this is deprecated');
		}

		const datum = createDatumFromBlockchainIdentifierV2({
			buyerAddress: buyerAddress,
			buyerReturnAddress,
			sellerAddress: sellerAddress,
			sellerReturnAddress: data.paymentRequest.sellerReturnAddress,
			blockchainIdentifier: data.paymentRequest.blockchainIdentifier,
			inputHash: data.paymentRequest.inputHash,
			payByTime: data.paymentRequest.payByTime,
			collateralReturnLovelace: data.overpaidLovelace,
			resultHash: null,
			resultTime: submitResultTime,
			unlockTime: unlockTime,
			externalDisputeUnlockTime: externalDisputeUnlockTime,
			newCooldownTimeSeller: BigInt(0),
			newCooldownTimeBuyer: BigInt(0),
			state: SmartContractState.FundsLocked,
		});
		logger.info('Batching payments, adding datum for payment request', {
			paymentRequestId: data.paymentRequest.id,
		});

		unsignedTx.sendAssets(
			{
				address: walletPairing.scriptAddress,
				datum,
			},
			data.paymentRequest.PaidFunds.map((amount) => ({
				unit: amount.unit == '' ? 'lovelace' : amount.unit,
				quantity: amount.amount.toString(),
			})),
		);
	}

	// Wallet "splitter" output for the funds-lock tx. Unlike script-spending
	// txs, the funds-lock has NO collateral declaration — wallet UTxOs are
	// consumed purely to fund the script outputs + fees, leaving only a
	// single change output back to the wallet (mesh's default). That drops
	// the wallet to 1 UTxO post-tx, below the 2-UTxO floor that
	// `ensureCollateralReady` requires for the NEXT script-spending tx (the
	// buyer's eventual collect-refund / authorize-withdrawal). Adding an
	// explicit pure-ADA self-send keeps the wallet at ≥2 outputs after the
	// lock: [splitter, change]. The splitter is the same constant used by
	// the V2 batch builders (`WALLET_SPLITTER_LOVELACE = 5 ADA`), sized so
	// it can serve directly as the collateral input on the next script tx
	// without scavenging a larger UTxO. See
	// `packages/payment-source-v2/src/builders/batch-helpers.ts` for the
	// constant's full lifecycle rationale.
	const buyerAddress = wallet.getUsedAddress().toBech32() as string;
	unsignedTx.sendAssets({ address: buyerAddress }, [
		{ unit: 'lovelace', quantity: WALLET_SPLITTER_LOVELACE.toString() },
	]);

	// Shared-Transaction pre-submit: REUSE the placeholder Transaction created
	// at wallet-lock time (already carries BlocksWallet → wallet). Every
	// batched purchase request connects to it via CurrentTransaction. Avoids
	// the N-orphan pattern that breaks HotWallet.pendingTransactionId @unique
	// (only the last create would survive).
	//
	// Falls back to creating a fresh sharedTx if the placeholder is missing —
	// defensive guard for the transitional upgrade window (e.g. an in-flight
	// scheduler tick from before this version landed). Should not occur in
	// steady state.
	const sharedTxId = await retryOnSerializationConflict(
		() =>
			prisma.$transaction(
				async (tx) => {
					let resolvedSharedTxId: string;
					if (walletPairing.placeholderTransactionId != null) {
						// Reuse path: bump `lastCheckedAt` so wallet-timeouts'
						// 1-min debounce resets against the new ts (the placeholder
						// is now actively progressing through pre-submit / submit /
						// post-submit) and reaffirm the BlocksWallet connection
						// defensively in case a competing writer touched it.
						await tx.transaction.update({
							where: { id: walletPairing.placeholderTransactionId },
							data: {
								status: TransactionStatus.Pending,
								lastCheckedAt: new Date(),
								BlocksWallet: { connect: { id: walletId } },
							},
						});
						resolvedSharedTxId = walletPairing.placeholderTransactionId;
					} else {
						const sharedTx = await tx.transaction.create({
							data: {
								status: TransactionStatus.Pending,
								// `lastCheckedAt: now` required so wallet-timeouts can poll this row.
								// See docs/adr/0006 and docs/adr/0007 for the full rationale.
								lastCheckedAt: new Date(),
								BlocksWallet: { connect: { id: walletId } },
							},
						});
						resolvedSharedTxId = sharedTx.id;
					}
					for (const request of batchedRequests) {
						logger.info('Batching payments, updating purchase request', {
							paymentRequestId: request.paymentRequest.id,
						});
						await tx.purchaseRequest.update({
							where: { id: request.paymentRequest.id },
							data: {
								...connectPreviousAction(request.paymentRequest.nextActionId),
								...createNextPurchaseAction(PurchasingAction.FundsLockingInitiated),
								collateralReturnLovelace: request.overpaidLovelace,
								SmartContractWallet: { connect: { id: walletId } },
								buyerReturnAddress: request.paymentRequest.buyerReturnAddress ?? walletPairing.collectionAddress,
								...connectExistingTransaction(resolvedSharedTxId),
								TransactionHistory: request.paymentRequest.CurrentTransaction
									? { connect: { id: request.paymentRequest.CurrentTransaction.id } }
									: undefined,
							},
						});
					}
					return resolvedSharedTxId;
				},
				{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
			),
		{ label: 'batch-payments-v2-presubmit' },
	);

	logger.info('Batching payments, purchase request initialized');

	// Clamp the lock tx's upper bound to the EARLIEST payByTime in the batch. The
	// default window reaches ~now+5.5min, but the scheduler admits requests with
	// payByTime as close as now+57s; without this clamp a slow build or congested
	// mempool lets the lock land after payByTime, and tx-sync then marks the
	// purchase FundsOrDatumInvalid on both sides with funds already locked
	// on-chain (unrecoverable). With the clamp the tx simply expires and is
	// retried next tick instead. Every payByTime is guaranteed non-null by the
	// loop above.
	const minPayByTime = batchedRequests.reduce<bigint>(
		(min, b) => (b.paymentRequest.payByTime! < min ? b.paymentRequest.payByTime! : min),
		batchedRequests[0].paymentRequest.payByTime!,
	);
	const { invalidBefore, invalidAfter } = createTxWindow(convertNetwork(paymentContract.network), {
		constrainAfterMs: minPayByTime,
	});
	unsignedTx.setNetwork(convertNetwork(paymentContract.network));
	unsignedTx.txBuilder.invalidBefore(invalidBefore);
	unsignedTx.txBuilder.invalidHereafter(invalidAfter);

	const rpcApiKey = paymentContract.PaymentSourceConfig.rpcProviderApiKey;
	// Wrap cost-model sync + build + sign in the per-paymentSource mutex so
	// two concurrent batch builds for the same payment source cannot
	// interleave their mutations of mesh's process-global
	// DEFAULT_V*_COST_MODEL_LIST arrays. Without this, a second build that
	// hits the 5-minute sync cache and skips the patch can call
	// `unsignedTx.build()` while the FIRST build is mid-flight (between
	// its sync and its `.build()`), and the script_data_hash captured by
	// mesh's hashScriptData drifts. See `src/utils/mesh-cost-model-sync`
	// for the full design note. The mutex is released as soon as `signTx`
	// returns — at that point the hash is baked into the signed body and
	// later global mutations cannot affect it. `submitTx` is outside the
	// critical section.
	const requestIds = batchedRequests.map((b) => b.paymentRequest.id);
	let completeTx: string;
	let signedTx: string;
	try {
		const built = await withMeshCostModelLock(rpcApiKey, async () => {
			await syncMeshCostModelsFromChainV2(rpcApiKey);
			const completeTx = await unsignedTx.build();
			logger.info('Batching payments, complete tx built');
			const signedTx = await wallet.signTx(completeTx);
			logger.info('Batching payments, tx signed');
			return { completeTx, signedTx };
		});
		completeTx = built.completeTx;
		signedTx = built.signedTx;
	} catch (buildError) {
		// build()/signTx run BEFORE submitTx and BEFORE intendedTxHash is
		// recorded — a throw here (insufficient balance, cost-model sync 5xx,
		// serialization error) means the tx was NEVER broadcast. Classify as
		// pre-submit-failed for an immediate revert+unlock. Without this the
		// throw escapes to the outer aggregator's `catch (uncaught)`, which
		// treats it as submit-ambiguous and strands the wallet a full ~15min
		// timeout waiting on reconciliation of a tx that does not exist.
		logger.warn('batch-payments build/sign failed pre-broadcast; reverting (never submitted)', {
			sharedTxId,
			requestIds,
			error: buildError instanceof Error ? buildError.message : buildError,
		});
		return {
			status: 'pre-submit-failed',
			walletId,
			sharedTxId,
			requestIds,
			error: buildError,
		};
	}

	// Funding double-lock guarantee (see #2 + #7 design): compute the
	// deterministic txHash + invalid_hereafter slot from the SIGNED txBody and
	// persist them BEFORE broadcast. If `submitTx` later throws ambiguously
	// (network/transport failure with unknown chain outcome), the
	// reconciliation worker queries the chain for this exact hash and either
	// promotes it to txHash (tx landed) or waits for `invalidHereafterSlot` to
	// pass before declaring the tx provably lost.
	const intendedTxHash = resolveTxHash(signedTx);
	const invalidHereafterSlot = invalidAfter;
	try {
		await retryOnSerializationConflict(
			() =>
				prisma.transaction.update({
					where: { id: sharedTxId },
					data: {
						intendedTxHash,
						invalidHereafterSlot: BigInt(invalidHereafterSlot),
						lastCheckedAt: new Date(),
					},
				}),
			{ label: 'batch-payments-v2-record-intended' },
		);
	} catch (recordError) {
		// Could not write the deterministic hash. We have NOT broadcast yet —
		// safe to revert and bail. Without intendedTxHash, the reconciliation
		// worker cannot resolve an ambiguous outcome, so we MUST NOT broadcast.
		logger.error('batch-payments could not record intendedTxHash; aborting submit', {
			sharedTxId,
			intendedTxHash,
			error: recordError instanceof Error ? recordError.message : recordError,
		});
		return {
			status: 'pre-submit-failed',
			walletId,
			sharedTxId,
			requestIds,
			error: recordError,
		};
	}

	let txHash: string;
	try {
		txHash = await wallet.submitTx(signedTx);
	} catch (submitError) {
		// Classify the throw:
		//   - Definitive node rejection (Mesh/Blockfrost says ledger rejected
		//     this txBody pre-broadcast) → SAFE to revert state.
		//   - Anything else (HTTP 5xx, ECONNRESET, timeouts) → ambiguous. DO
		//     NOT touch request state, DO NOT mark RolledBack. Leave the row
		//     Pending with `intendedTxHash` set; the reconciliation worker
		//     resolves it once the chain reports definitively (found → promote,
		//     not-found AND past invalidHereafterSlot → safely revert).
		const definitive = isDefinitiveNodeRejection(submitError);
		if (definitive) {
			logger.warn('batch-payments submit definitively rejected by node', {
				sharedTxId,
				intendedTxHash,
				error: submitError instanceof Error ? submitError.message : submitError,
			});
			return {
				status: 'submit-rejected',
				walletId,
				sharedTxId,
				intendedTxHash,
				requestIds,
				error: submitError,
			};
		}
		logger.warn('batch-payments submit AMBIGUOUS; leaving Pending for reconciliation', {
			sharedTxId,
			intendedTxHash,
			invalidHereafterSlot,
			error: submitError instanceof Error ? submitError.message : submitError,
		});
		return {
			status: 'submit-ambiguous',
			walletId,
			sharedTxId,
			intendedTxHash,
			invalidHereafterSlot,
			requestIds,
			error: submitError,
		};
	}

	// Node responded with a txHash — that means the tx is on chain (or at least
	// the node has it). Assert it matches the deterministic intendedTxHash we
	// computed; a mismatch is a Mesh/Cardano bug we must not silently swallow,
	// because we'd record the wrong hash and reconciliation would never resolve
	// the row.
	if (txHash !== intendedTxHash) {
		logger.error('batch-payments node returned divergent txHash; treating as ambiguous', {
			sharedTxId,
			intendedTxHash,
			nodeTxHash: txHash,
		});
		return {
			status: 'submit-ambiguous',
			walletId,
			sharedTxId,
			intendedTxHash,
			invalidHereafterSlot,
			requestIds,
			error: new Error(`Node returned divergent txHash ${txHash} vs intended ${intendedTxHash}`),
		};
	}

	// Non-fatal: the tx is already on chain (submitTx returned a matching hash).
	// A balance-monitor throw here must NOT propagate to the outer aggregator's
	// `catch (uncaught)` and get misclassified as submit-ambiguous — the submit
	// already succeeded and the txHash is about to be recorded below.
	try {
		await walletLowBalanceMonitorService.evaluateProjectedHotWalletById({
			hotWalletId: walletId,
			walletAddress: walletPairing.changeAddress,
			walletUtxos: walletPairing.utxos,
			unsignedTx: completeTx,
			checkSource: 'submission',
			currentBalanceMap: walletPairing.currentBalanceMap ?? undefined,
		});
	} catch (balanceError) {
		logger.warn('batch-payments post-submit balance monitor failed (non-fatal; tx already on chain)', {
			walletId,
			txHash,
			error: balanceError instanceof Error ? balanceError.message : balanceError,
		});
	}

	logger.info('Batching payments, tx submitted', {
		txHash: txHash,
	});

	// Post-submit: single shared Transaction row receives the txHash. No
	// per-request loop required. Wrapped in retry — if it still fails the tx
	// IS on chain (intendedTxHash will catch it via reconciliation), so we
	// surface as `post-submit-db-failed` so the outer aggregator can attempt
	// one more direct update before falling through to reconciliation.
	try {
		await retryOnSerializationConflict(
			() =>
				prisma.transaction.update({
					where: { id: sharedTxId },
					data: { txHash },
				}),
			{ label: 'batch-payments-v2-post-submit-hash' },
		);
	} catch (postSubmitError) {
		return {
			status: 'post-submit-db-failed',
			walletId,
			sharedTxId,
			txHash,
			requestIds,
			error: postSubmitError,
		};
	}
	logger.info('Batching payments, purchase request updated');

	return {
		status: 'succeeded',
		walletId,
		sharedTxId,
		txHash,
		requestIds,
	};
}

export async function batchLatestPaymentEntriesV2() {
	const maxBatchSize = 10;

	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch {
		logger.info('batch_payments_v2 is already running, skipping cycle');
		return;
	}

	try {
		// Gate Serializable $transaction through the shared semaphore so the pg
		// connection pool isn't exhausted under scheduler fan-out.
		const paymentContractsWithWalletLocked = await withSerializableSlot(() =>
			retryOnSerializationConflict(
				() =>
					prisma.$transaction(
						async (prisma) => {
							const payByTime = new Date().getTime() + 1000 * 57;
							const paymentContracts = await prisma.paymentSource.findMany({
								where: {
									deletedAt: null,
									paymentSourceType: PaymentSourceType.Web3CardanoV2,
									HotWallets: {
										some: {
											PendingTransaction: null,
											lockedAt: null,
											type: HotWalletType.Purchasing,
											deletedAt: null,
										},
									},
								},
								include: {
									PurchaseRequests: {
										where: {
											NextAction: {
												requestedAction: PurchasingAction.FundsLockingRequested,
												errorType: null,
											},
											CurrentTransaction: { is: null },
											onChainState: null,
											payByTime: { gte: payByTime },
										},
										include: {
											PaidFunds: true,
											SellerWallet: true,
											SmartContractWallet: { where: { deletedAt: null } },
											NextAction: true,
											CurrentTransaction: true,
											HotWalletLimit: { select: { id: true } },
										},
										orderBy: {
											createdAt: 'asc',
										},
										take: maxBatchSize,
									},
									PaymentSourceConfig: true,
									HotWallets: {
										where: {
											PendingTransaction: null,
											lockedAt: null,
											type: HotWalletType.Purchasing,
											deletedAt: null,
										},
										include: {
											Secret: true,
										},
									},
								},
							});

							const walletsToLock: HotWallet[] = [];
							const paymentContractsToUse = [];
							for (const paymentContract of paymentContracts) {
								const newestCreatedAt = getNewestPurchaseRequestCreatedAt(paymentContract.PurchaseRequests);
								const settleWindowMs = getBatchSettleWindowMs(paymentContract.PurchaseRequests.length);
								const createdBefore = new Date(Date.now() - settleWindowMs);
								if (
									newestCreatedAt != null &&
									paymentContract.PurchaseRequests.length < maxBatchSize &&
									newestCreatedAt > createdBefore
								) {
									logger.info('Waiting for V2 funds-lock batch settle window before locking purchasing wallet', {
										paymentSourceId: paymentContract.id,
										requestCount: paymentContract.PurchaseRequests.length,
										newestCreatedAt: newestCreatedAt.toISOString(),
										settleWindowMs,
									});
									continue;
								}

								const purchaseRequests = [];
								for (const purchaseRequest of paymentContract.PurchaseRequests) {
									//if the purchase request times out in less than 5 minutes, we ignore it
									//(deadline is within the next 5 minutes or already past — the seller
									//can never submit in time, so locking funds only forces a refund)
									const maxSubmitResultTime = Date.now() + 1000 * 60 * 5;
									if (purchaseRequest.inputHash == null) {
										logger.info('Purchase request has no input hash, ignoring', {
											purchaseRequest: purchaseRequest,
										});
										await prisma.purchaseRequest.update({
											where: { id: purchaseRequest.id },
											data: {
												ActionHistory: {
													connect: {
														id: purchaseRequest.nextActionId,
													},
												},
												NextAction: {
													create: {
														requestedAction: PurchasingAction.WaitingForManualAction,
														errorType: PurchaseErrorType.Unknown,
														errorNote: 'Purchase request has no input hash',
													},
												},
											},
										});
										continue;
									} else if (purchaseRequest.submitResultTime < maxSubmitResultTime) {
										logger.info('Purchase request times out in less than 5 minutes, ignoring', {
											purchaseRequest: purchaseRequest,
										});
										await prisma.purchaseRequest.update({
											where: { id: purchaseRequest.id },
											data: {
												ActionHistory: {
													connect: {
														id: purchaseRequest.nextActionId,
													},
												},
												NextAction: {
													create: {
														requestedAction: PurchasingAction.FundsLockingRequested,
														errorType: PurchaseErrorType.Unknown,
														errorNote: 'Transaction timeout before sending',
													},
												},
											},
										});
										continue;
									}
									purchaseRequests.push(purchaseRequest);
								}
								if (purchaseRequests.length == 0) {
									continue;
								}
								paymentContract.PurchaseRequests = purchaseRequests;
								for (const wallet of paymentContract.HotWallets) {
									if (!walletsToLock.some((w) => w.id === wallet.id)) {
										walletsToLock.push(wallet);
										// Create a placeholder Transaction row BEFORE setting
										// lockedAt and connect it as the wallet's PendingTransaction
										// in the same write. Without the placeholder the wallet
										// orphan-cleanup branch in wallet-timeouts has to wait
										// WALLET_LOCK_TIMEOUT_INTERVAL to detect the orphan via the
										// `lockedAt set + no PendingTransaction` arm (the only path
										// it has for a lock with nothing to poll). With the
										// placeholder, the standard PendingTransaction polling
										// branch picks it up after 1 minute and — because txHash
										// stays null until executeSpecificBatchPayment populates it
										// — disconnects + marks RolledBack via the early-bail
										// `txHash == null` branch in wallet-timeouts/service.ts.
										// `executeSpecificBatchPayment` REUSES this placeholder by
										// updating its `lastCheckedAt` (rather than creating a new
										// sharedTx) since HotWallet.pendingTransactionId @unique
										// allows only one connected Tx at a time.
										const placeholder = await prisma.transaction.create({
											data: {
												status: TransactionStatus.Pending,
												// lastCheckedAt: now keeps wallet-timeouts' 1-min
												// debounce honored — without it the polling cron
												// would fire on the next tick (NULL matches `lte`
												// in Postgres but wallet-timeouts filters on a
												// non-null `lastCheckedAt` via `lte: now-1min`).
												lastCheckedAt: new Date(),
												BlocksWallet: { connect: { id: wallet.id } },
											},
										});
										await prisma.hotWallet.update({
											where: { id: wallet.id, deletedAt: null },
											data: { lockedAt: new Date() },
										});
										// Stash the placeholder Tx id on the wallet object so
										// executeSpecificBatchPayment can reuse it. Wallet is a
										// generated Prisma type, but the closure flows through
										// untyped paymentContract.HotWallets — see
										// loadPlaceholderTxIdForWallet for the read site.
										(wallet as HotWallet & { placeholderTransactionId?: string }).placeholderTransactionId =
											placeholder.id;
									}
								}
								if (paymentContract.PurchaseRequests.length > 0) {
									paymentContractsToUse.push(paymentContract);
								}
							}
							return paymentContractsToUse;
						},
						{ isolationLevel: 'Serializable', maxWait: 10000, timeout: 10000 },
					),
				{ label: 'batch-payments-0' },
			),
		);

		await Promise.allSettled(
			paymentContractsWithWalletLocked.map(async (paymentContract) => {
				try {
					const paymentRequests = paymentContract.PurchaseRequests;
					if (paymentRequests.length == 0) {
						logger.info(
							'No payment requests found for network ' +
								paymentContract.network +
								' ' +
								paymentContract.smartContractAddress,
						);
						return;
					}

					const potentialWallets = paymentContract.HotWallets;
					if (potentialWallets.length == 0) {
						logger.warn('No unlocked wallet to batch payments, skipping');
						return;
					}

					const walletAmounts = await Promise.all(
						potentialWallets.map(async (wallet) => {
							const {
								wallet: meshWallet,
								utxos,
								address,
							} = await generateWalletExtended(
								paymentContract.network,
								paymentContract.PaymentSourceConfig.rpcProviderApiKey,
								wallet.Secret.encryptedMnemonic,
							);
							const balanceMap = toBalanceMapFromMeshUtxos(utxos);
							const currentBalanceMap = await walletLowBalanceMonitorService.evaluateCurrentHotWalletById(
								wallet.id,
								'submission',
							);
							return {
								wallet: meshWallet,
								walletId: wallet.id,
								changeAddress: address,
								collectionAddress: wallet.collectionAddress,
								utxos,
								currentBalanceMap,
								scriptAddress: paymentContract.smartContractAddress,
								amounts: Array.from(balanceMap.entries()).map(([unit, quantity]) => ({
									unit: unit === 'lovelace' ? '' : unit,
									quantity,
								})),
								// Surface the placeholder Transaction id stashed on the
								// wallet object inside the outer lock-and-query transaction.
								// Untyped because HotWallet is generated by Prisma —
								// see the placeholder create site above.
								placeholderTransactionId:
									(wallet as HotWallet & { placeholderTransactionId?: string }).placeholderTransactionId ?? null,
							};
						}),
					);
					const paymentRequestsRemaining = [...paymentRequests];
					const walletPairings: WalletPairing[] = [];
					const walletFitMisses: Array<{
						walletId: string;
						purchaseRequestId: string;
						unit: string;
						requiredAmount: string;
						availableAmount: string;
						batchedCountBeforeMiss: number;
					}> = [];

					let maxBatchSizeReached = false;

					const blockchainProvider = await createMeshProvider(paymentContract.PaymentSourceConfig.rpcProviderApiKey);

					const protocolParameter = await blockchainProvider.fetchProtocolParameters();

					for (const walletData of walletAmounts) {
						const wallet = walletData.wallet;
						const amounts = walletData.amounts;
						const potentialAddresses = await wallet.getUsedAddresses();
						if (potentialAddresses.length == 0) {
							logger.warn('No addresses found for wallet ' + walletData.walletId);
							continue;
						}
						const batchedPaymentRequests = [];

						let index = 0;
						while (paymentRequestsRemaining.length > 0 && index < paymentRequestsRemaining.length) {
							if (batchedPaymentRequests.length >= maxBatchSize) {
								maxBatchSizeReached = true;
								break;
							}
							const paymentRequest = paymentRequestsRemaining[index];
							if (
								paymentRequest.isLimitedToHotWallets &&
								!paymentRequest.HotWalletLimit.some((hw) => hw.id === walletData.walletId)
							) {
								index++;
								continue;
							}
							// Work on a clone of the Prisma-loaded PaidFunds array. The
							// inner loop augments the lovelace amount with the derived
							// `overestimatedMinUtxoCost` so downstream tx-build code sees
							// the value the on-chain output will actually carry. Mutating
							// `paymentRequest.PaidFunds` directly would persist that
							// augmentation into the Prisma object — harmless on the happy
							// path (we'd reassign anyway) but fragile if any future change
							// reads `paymentRequest.PaidFunds` after a non-fulfilled try,
							// or stores a reference to the row outside this loop. Cloning
							// up front and reassigning on success keeps the original array
							// untouched on the non-fulfilled branch with no explicit
							// rollback step.
							const workingPaidFunds = paymentRequest.PaidFunds.map((f) => ({ ...f }));
							const sellerAddress = paymentRequest.SellerWallet.walletAddress;

							const otherUnits = workingPaidFunds.filter(
								(amount) => amount.unit.toLowerCase() != '' && amount.unit.toLowerCase() != 'lovelace',
							).length;

							// V2 datum carries `collateralReturnLovelace` whose CBOR size
							// grows with the value (a non-zero BigInt is ~3-4 bytes vs 1
							// byte for 0n). The actual on-chain datum will use the
							// derived `overpaidLovelace` as collateralReturnLovelace, so
							// estimating min-UTxO with 0n understates it by ~2 bytes ×
							// coinsPerUtxoSize (~8.6k lovelace at current params). Fix:
							// iterate the min-UTxO calculation until the estimate uses
							// the same collateralReturnLovelace value that the lock
							// output will carry. Two iterations always suffice in
							// practice (the size difference between 0n and ~6M is at
							// most 4 bytes; the second pass's overpaidLovelace is in the
							// same size class as the first, so its CBOR size matches).
							//
							// INTENTIONAL `state: ResultSubmitted` + `resultHash: DUMMY_RESULT_HASH`
							// (not `FundsLocked` + null). The actual lock datum will be
							// FundsLocked + null (~33 bytes smaller). We deliberately
							// over-size the lock for the LARGER ResultSubmitted datum
							// because the validator's `output_value_is_preserved` uses
							// `>=` (vested_pay.ak L743) — the lock UTxO's value cannot
							// shrink across transitions but CAN grow. The ledger's
							// per-output min-UTxO check applies to the NEW datum at
							// SubmitResult time, so without pre-funding the seller would
							// need to top up the continuation from their own wallet
							// inputs (extra fees, extra UTxO selection, possible failure
							// on a near-empty seller wallet). Pre-funding ~0.14 ADA per
							// lock (32 bytes × coinsPerUtxoSize) eliminates that
							// failure mode; the over-pre-funded amount is recorded as
							// `collateralReturnLovelace` and is returned to the buyer at
							// settlement, so no funds are lost — just briefly siloed.
							//
							// TODO(verify-on-chain): add an e2e regression that sizes a
							// lock for `FundsLocked + null` and confirms the seller's
							// SubmitResult fails without a wallet top-up. Confirms this
							// trade-off is real before any future capital-efficiency
							// micro-optimization is considered.
							const buildEstimateDatum = (collateralReturnLovelace: bigint) =>
								createDatumFromBlockchainIdentifierV2({
									buyerAddress: walletData.changeAddress,
									buyerReturnAddress: paymentRequest.buyerReturnAddress ?? walletData.collectionAddress,
									sellerAddress: sellerAddress,
									sellerReturnAddress: paymentRequest.sellerReturnAddress,
									blockchainIdentifier: paymentRequest.blockchainIdentifier,
									inputHash: paymentRequest.inputHash,
									payByTime: paymentRequest.payByTime!,
									collateralReturnLovelace,
									resultHash: DUMMY_RESULT_HASH,
									resultTime: BigInt(paymentRequest.submitResultTime),
									unlockTime: BigInt(paymentRequest.unlockTime),
									externalDisputeUnlockTime: BigInt(paymentRequest.externalDisputeUnlockTime),
									newCooldownTimeSeller: BigInt(0),
									newCooldownTimeBuyer: BigInt(0),
									state: SmartContractState.ResultSubmitted,
								});

							const computeMinUtxoFor = (collateralReturnLovelace: bigint) =>
								calculateMinUtxo({
									datum: buildEstimateDatum(collateralReturnLovelace).value,
									nativeTokenCount: otherUnits,
									coinsPerUtxoSize: protocolParameter.coinsPerUtxoSize,
									includeBuffers: true,
								}).minUtxoLovelace;

							const paidLovelaceAtThisPoint =
								workingPaidFunds.find((amount) => amount.unit.toLowerCase() === '')?.amount ?? 0n;

							// Pass 1: estimate min-UTxO assuming no collateral return.
							let overestimatedMinUtxoCost = computeMinUtxoFor(0n);
							// Pass 2: estimate min-UTxO assuming the collateral return
							// value the lock will actually emit (overpaid component of
							// the lovelace going to script). Two iterations is enough —
							// the CBOR length of `overpaidLovelace` is at most 4 bytes
							// for any realistic amount, so the size class is stable.
							const projectedOverpaid =
								overestimatedMinUtxoCost > paidLovelaceAtThisPoint
									? overestimatedMinUtxoCost - paidLovelaceAtThisPoint
									: 0n;
							const iteratedMinUtxoCost = computeMinUtxoFor(projectedOverpaid);
							if (iteratedMinUtxoCost > overestimatedMinUtxoCost) {
								overestimatedMinUtxoCost = iteratedMinUtxoCost;
							}

							//set min ada required;
							const lovelaceRequired = workingPaidFunds.findIndex((amount) => amount.unit.toLowerCase() === '');
							let overpaidLovelace = 0n;
							if (lovelaceRequired == -1) {
								overpaidLovelace = overestimatedMinUtxoCost;
								workingPaidFunds.push({
									unit: '',
									amount: overestimatedMinUtxoCost,
									id: '',
									createdAt: new Date(),
									updatedAt: new Date(),
									paymentRequestId: null,
									purchaseRequestId: null,
									apiKeyId: null,
									agentFixedPricingId: null,
									sellerWithdrawnPaymentRequestId: null,
									buyerWithdrawnPaymentRequestId: null,
									buyerWithdrawnPurchaseRequestId: null,
									sellerWithdrawnPurchaseRequestId: null,
								});
							} else if (workingPaidFunds[lovelaceRequired].amount < overestimatedMinUtxoCost) {
								overpaidLovelace = overestimatedMinUtxoCost - workingPaidFunds[lovelaceRequired].amount;
								if (overpaidLovelace < 0n) {
									overpaidLovelace = 0n;
								}
								//we want to be overpaid lovelace to be 0 or at least 1.43523 ada
								//example: overestimatedMinUtxoCost 3 ada
								//paidFunds 2.5 ada
								//overpaidLovelace 0.5 ada
								//we want to be overpaid lovelace to be 1.43523 ada
								//so we need to add 1.43523 ada - 0.5 ada = 0.93523 ada
								if (overpaidLovelace > 0n && overpaidLovelace < CONSTANTS.MIN_COLLATERAL_LOVELACE) {
									overestimatedMinUtxoCost += CONSTANTS.MIN_COLLATERAL_LOVELACE - overpaidLovelace;
									overpaidLovelace = CONSTANTS.MIN_COLLATERAL_LOVELACE;
								}

								workingPaidFunds.splice(lovelaceRequired, 1);
								workingPaidFunds.push({
									unit: '',
									amount: overestimatedMinUtxoCost,
									id: '',
									createdAt: new Date(),
									updatedAt: new Date(),
									paymentRequestId: null,
									purchaseRequestId: null,
									apiKeyId: null,
									agentFixedPricingId: null,
									sellerWithdrawnPaymentRequestId: null,
									buyerWithdrawnPaymentRequestId: null,
									buyerWithdrawnPurchaseRequestId: null,
									sellerWithdrawnPurchaseRequestId: null,
								});
							}
							let isFulfilled = true;
							let fitMiss: (typeof walletFitMisses)[number] | null = null;
							// Charge the once-per-batch overhead (fee + splitter, see
							// BATCH_TX_LOVELACE_OVERHEAD) on the first batched request only.
							const needsFeeBuffer = batchedPaymentRequests.length === 0;
							for (const paymentAmount of workingPaidFunds) {
								const walletAmount = amounts.find((amount) => amount.unit == paymentAmount.unit);
								const isLovelace = paymentAmount.unit === '' || paymentAmount.unit.toLowerCase() === 'lovelace';
								const requiredAmount =
									isLovelace && needsFeeBuffer
										? paymentAmount.amount + BATCH_TX_LOVELACE_OVERHEAD
										: paymentAmount.amount;
								if (walletAmount == null || requiredAmount > walletAmount.quantity) {
									isFulfilled = false;
									fitMiss = {
										walletId: walletData.walletId,
										purchaseRequestId: paymentRequest.id,
										unit: paymentAmount.unit,
										requiredAmount: requiredAmount.toString(),
										availableAmount: (walletAmount?.quantity ?? 0n).toString(),
										batchedCountBeforeMiss: batchedPaymentRequests.length,
									};
									break;
								}
							}
							if (isFulfilled) {
								const wasFirstRequest = batchedPaymentRequests.length === 0;
								// Adopt the augmented array on the Prisma object so
								// downstream tx-build code (in `executeSpecificBatchPayment`)
								// reads the lovelace value the lock output will carry.
								// Replacing the reference (rather than mutating the original
								// array in-place) keeps the original array object pristine,
								// so any retry / parallel iteration that re-fetches the row
								// from Prisma starts from a clean slate.
								paymentRequest.PaidFunds = workingPaidFunds;
								batchedPaymentRequests.push({
									paymentRequest,
									overpaidLovelace,
								});
								// Deduct exactly what requiredAmount reserved (incl. the
								// once-per-batch overhead) so subsequent requests fit against the
								// real remaining balance.
								for (const paymentAmount of workingPaidFunds) {
									const walletAmount = amounts.find((amount) => amount.unit == paymentAmount.unit);
									const isLovelace = paymentAmount.unit === '' || paymentAmount.unit.toLowerCase() === 'lovelace';
									const deductAmount =
										isLovelace && wasFirstRequest
											? paymentAmount.amount + BATCH_TX_LOVELACE_OVERHEAD
											: paymentAmount.amount;
									walletAmount!.quantity -= deductAmount;
								}
								paymentRequestsRemaining.splice(index, 1);
							} else {
								// Nothing to roll back — workingPaidFunds is local; the
								// Prisma object's PaidFunds array was never touched.
								if (fitMiss != null) {
									walletFitMisses.push(fitMiss);
								}
								index++;
							}
						}
						if (batchedPaymentRequests.length > 0) {
							logger.info('Batching payments, adding wallet pairing', {
								walletId: walletData.walletId,
								scriptAddress: walletData.scriptAddress,
								batchedRequests: batchedPaymentRequests,
							});
							walletPairings.push({
								wallet: wallet,
								scriptAddress: walletData.scriptAddress,
								walletId: walletData.walletId,
								changeAddress: walletData.changeAddress,
								collectionAddress: walletData.collectionAddress,
								utxos: walletData.utxos,
								currentBalanceMap: walletData.currentBalanceMap,
								batchedRequests: batchedPaymentRequests,
								placeholderTransactionId: walletData.placeholderTransactionId,
							});
						}
					}
					if (paymentRequestsRemaining.length > 0 && walletFitMisses.length > 0) {
						logger.warn('V2 funds-lock batch left purchase requests unpaired after wallet-fit', {
							paymentSourceId: paymentContract.id,
							remainingPurchaseRequestIds: paymentRequestsRemaining.map((request) => request.id),
							pairedRequestCount: walletPairings.reduce((count, pairing) => count + pairing.batchedRequests.length, 0),
							walletFitMisses,
						});
					}
					//only go into error state if we did not reach max batch size, as otherwise we might have enough funds in other wallets
					if (paymentRequestsRemaining.length > 0 && maxBatchSizeReached == false) {
						//count all existing wallets, including ones busy with a pending transaction or locked by
						//a concurrent run: a busy wallet frees up with its funds intact, so it must suppress the
						//permanent error state instead of being treated as nonexistent
						const allWalletCount = await prisma.hotWallet.count({
							where: {
								deletedAt: null,
								type: HotWalletType.Purchasing,
								PaymentSource: {
									id: paymentContract.id,
								},
							},
						});
						//only go into error state if all eligible wallets were evaluated this run, otherwise we might have enough funds in busy wallets
						for (const paymentRequest of paymentRequestsRemaining) {
							const eligibleWalletCount = paymentRequest.isLimitedToHotWallets
								? await prisma.hotWallet.count({
										where: {
											deletedAt: null,
											type: HotWalletType.Purchasing,
											PaymentSource: { id: paymentContract.id },
											id: { in: paymentRequest.HotWalletLimit.map((hw) => hw.id) },
										},
									})
								: allWalletCount;
							const eligiblePotentialCount = paymentRequest.isLimitedToHotWallets
								? potentialWallets.filter((w) => paymentRequest.HotWalletLimit.some((hw) => hw.id === w.id)).length
								: potentialWallets.length;
							if (eligibleWalletCount == eligiblePotentialCount) {
								logger.warn('No wallets with funds found, going into error state for', {
									purchaseRequestId: paymentRequest.id,
									eligibleWalletCount,
									eligiblePotentialCount,
								});
								await prisma.purchaseRequest.update({
									where: { id: paymentRequest.id },
									data: {
										ActionHistory: {
											connect: {
												id: paymentRequest.nextActionId,
											},
										},
										NextAction: {
											create: {
												requestedAction: PurchasingAction.WaitingForManualAction,
												errorType: PurchaseErrorType.InsufficientFunds,
												errorNote:
													paymentRequest.inputHash == null
														? 'Purchase request has no input hash and not enough funds in wallets'
														: 'Not enough funds in wallets',
											},
										},
									},
								});
							}
						}
					}

					await unlockUnusedPurchasingWallets(
						potentialWallets.map((wallet) => wallet.id),
						walletPairings.map((walletPairing) => walletPairing.walletId),
					);

					if (walletPairings.length == 0) {
						logger.info('No purchase requests with funds found, skipping');
						return;
					}

					// Map walletId → walletPairing so the outcome-dispatch loop below
					// can look the original pairing up by id (walletPairings array is
					// not closed over per-outcome iteration).
					const pairingByWalletId = new Map<string, (typeof walletPairings)[number]>(
						walletPairings.map((p) => [p.walletId, p]),
					);

					logger.info(`Batching ${walletPairings.length} payments for payment source ${paymentContract.id}`);
					// Per-pairing structured outcomes — see BatchPairingOutcome. We
					// removed the previous `Promise.race(30s, executeSpecificBatchPayment)`
					// pattern: the timeout rejected the wrapper but did NOT cancel the
					// in-flight `submitTx`, so a late successful broadcast could land on
					// chain while the outer catch had already advanced every batched
					// request to `WaitingForManualAction`. Operator clearing the manual-
					// action state would then risk a second lock against funds already on
					// chain. Per-tick mutex (`mutex` above) is the overlap defense; a
					// single batch that exceeds 30s now logs but completes, and ambiguous
					// outcomes are routed to `funding-reconciliation` for chain-truth
					// resolution rather than guessing locally.
					const outcomes = await Promise.allSettled(
						walletPairings.map(async (walletPairing): Promise<BatchPairingOutcome> => {
							try {
								return await executeSpecificBatchPayment(walletPairing, paymentContract, blockchainProvider);
							} catch (uncaught) {
								// executeSpecificBatchPayment SHOULD always return a structured outcome.
								// An uncaught throw is a programmer bug — treat as ambiguous to keep the
								// double-lock guarantee (don't auto-revert request state).
								logger.error('batch-payments inner threw instead of returning outcome — treating as ambiguous', {
									walletId: walletPairing.walletId,
									error: uncaught instanceof Error ? { message: uncaught.message, stack: uncaught.stack } : uncaught,
								});
								return {
									status: 'submit-ambiguous',
									walletId: walletPairing.walletId,
									sharedTxId: walletPairing.placeholderTransactionId ?? '',
									intendedTxHash: '',
									invalidHereafterSlot: 0,
									requestIds: walletPairing.batchedRequests.map((b) => b.paymentRequest.id),
									error: uncaught,
								};
							}
						}),
					);

					for (const settled of outcomes) {
						// Inner function always returns structured outcomes, so settled is
						// always 'fulfilled'. Defense-in-depth: handle rejected anyway.
						if (settled.status === 'rejected') {
							const reason: unknown = settled.reason;
							logger.error('batch-payments unexpected outer rejection', {
								reason: reason instanceof Error ? reason.message : String(reason),
							});
							continue;
						}
						const outcome = settled.value;
						switch (outcome.status) {
							case 'succeeded':
								// Wallet stays locked until tx-sync sees the confirmation;
								// that's the existing behavior. Nothing to do.
								logger.info('batch-payments pairing succeeded', {
									walletId: outcome.walletId,
									sharedTxId: outcome.sharedTxId,
									txHash: outcome.txHash,
									requestCount: outcome.requestIds.length,
								});
								break;

							case 'post-submit-db-failed':
								// txHash IS on chain and known; one last attempt to persist
								// the hash. If THIS fails too, reconciliation handles it via
								// intendedTxHash already stored pre-submit.
								logger.warn('batch-payments post-submit DB failed; retrying txHash persistence', {
									walletId: outcome.walletId,
									sharedTxId: outcome.sharedTxId,
									txHash: outcome.txHash,
									error: outcome.error instanceof Error ? outcome.error.message : outcome.error,
								});
								try {
									await retryOnSerializationConflict(
										() =>
											prisma.transaction.update({
												where: { id: outcome.sharedTxId },
												data: { txHash: outcome.txHash },
											}),
										{ label: 'batch-payments-v2-post-submit-retry-outer' },
									);
								} catch (retryError) {
									logger.error(
										'batch-payments post-submit DB retry also failed; reconciliation will resolve via intendedTxHash',
										{ walletId: outcome.walletId, sharedTxId: outcome.sharedTxId, error: retryError },
									);
								}
								break;

							case 'submit-rejected':
							case 'pre-submit-failed': {
								// Definitive failure with no on-chain effect (or no broadcast attempted).
								// SAFE to revert request state and unlock the wallet.
								//
								// A pre-submit failure caused by a TRANSIENT error (cost-model sync /
								// Blockfrost 5xx / transport drop during build+sign) is not a real
								// failure — the tx was never broadcast and a later tick can succeed.
								// Revert those to FundsLockingRequested so the scheduler re-batches
								// them instead of parking a whole batch in WaitingForManualAction for
								// an operator. Node rejections and non-transient build errors still go
								// to manual action.
								const isRetryableTransient =
									outcome.status === 'pre-submit-failed' && isTransientPreSubmitError(outcome.error);
								const errNote =
									outcome.status === 'submit-rejected'
										? 'Batching payments rejected by node: ' + interpretBlockchainError(outcome.error)
										: 'Batching payments pre-submit failure: ' +
											(outcome.error instanceof Error ? outcome.error.message : String(outcome.error));
								logger.warn(
									`batch-payments pairing ${outcome.status}; ${
										isRetryableTransient ? 'transient — requeuing for retry' : 'reverting + unlocking'
									}`,
									{
										walletId: outcome.walletId,
										sharedTxId: outcome.sharedTxId,
									},
								);
								const originalPairing = pairingByWalletId.get(outcome.walletId);
								const batchedRequestsForRevert = originalPairing?.batchedRequests ?? [];
								for (const batchedRequest of batchedRequestsForRevert) {
									await prisma.purchaseRequest.update({
										where: { id: batchedRequest.paymentRequest.id },
										data: {
											ActionHistory: {
												connect: { id: batchedRequest.paymentRequest.nextActionId },
											},
											NextAction: {
												create: isRetryableTransient
													? {
															requestedAction: PurchasingAction.FundsLockingRequested,
															errorType: null,
															errorNote: null,
														}
													: {
															requestedAction: PurchasingAction.WaitingForManualAction,
															errorType: PurchaseErrorType.Unknown,
															errorNote: errNote,
														},
											},
										},
									});
								}
								if (outcome.sharedTxId != null) {
									try {
										await prisma.transaction.update({
											where: { id: outcome.sharedTxId },
											data: { status: TransactionStatus.RolledBack },
										});
									} catch (rollbackError) {
										logger.warn('batch-payments rollback mark failed (non-fatal)', {
											sharedTxId: outcome.sharedTxId,
											error: rollbackError instanceof Error ? rollbackError.message : rollbackError,
										});
									}
								}
								await prisma.hotWallet.update({
									where: { id: outcome.walletId, deletedAt: null },
									data: {
										lockedAt: null,
										PendingTransaction: { disconnect: true },
									},
								});
								break;
							}

							case 'submit-ambiguous':
								// CRITICAL: do NOT revert request state, do NOT mark
								// RolledBack, do NOT unlock the wallet. The tx MAY be on
								// chain. The shared Transaction row keeps `intendedTxHash`
								// + `invalidHereafterSlot` set; `funding-reconciliation`
								// resolves it once the chain reports definitively.
								//
								// Wallet stays locked → wallet-timeouts cannot recover it
								// until reconciliation flips the Transaction's status (or
								// confirms it on chain via tx-sync).
								logger.warn('batch-payments pairing AMBIGUOUS; leaving for funding-reconciliation', {
									walletId: outcome.walletId,
									sharedTxId: outcome.sharedTxId,
									intendedTxHash: outcome.intendedTxHash,
									invalidHereafterSlot: outcome.invalidHereafterSlot,
									requestCount: outcome.requestIds.length,
									error: outcome.error instanceof Error ? outcome.error.message : outcome.error,
								});
								break;
						}
					}
				} catch (error) {
					logger.error('Error batching payments outer', { error: error });

					const potentiallyFailedPurchaseRequests = paymentContract.PurchaseRequests;
					const failedPurchaseRequests = await prisma.purchaseRequest.findMany({
						where: {
							id: { in: potentiallyFailedPurchaseRequests.map((x) => x.id) },
							CurrentTransaction: {
								is: null,
							},
							NextAction: {
								requestedAction: PurchasingAction.FundsLockingRequested,
							},
						},
					});

					// Rows that advanced to FundsLockingInitiated but never submitted
					// (intendedTxHash IS NULL ⇒ no tx left the host). The wallet-unlock
					// loop below rolls back their sharedTx, so funding-reconciliation
					// can't resolve them (it polls by intendedTxHash); revert to
					// FundsLockingRequested so the next tick re-batches them.
					const orphanedInitiatedRequests = await prisma.purchaseRequest.findMany({
						where: {
							id: { in: potentiallyFailedPurchaseRequests.map((x) => x.id) },
							NextAction: {
								requestedAction: PurchasingAction.FundsLockingInitiated,
							},
							CurrentTransaction: {
								is: {
									intendedTxHash: null,
									txHash: null,
								},
							},
						},
						include: { NextAction: true, CurrentTransaction: true },
					});
					if (orphanedInitiatedRequests.length > 0) {
						logger.warn('batch-payments outer-catch reverting orphaned FundsLockingInitiated rows', {
							count: orphanedInitiatedRequests.length,
							ids: orphanedInitiatedRequests.map((r) => r.id),
						});
					}

					// Outer-catch wallet unlock — every wallet that the lock-and-query
					// step touched now carries a placeholder PendingTransaction, so the
					// previous `pendingTransactionId: null` filter would match none of
					// them. Walk each candidate, rollback its placeholder, disconnect,
					// then clear lockedAt — same pattern as unlockUnusedPurchasingWallets
					// uses for the un-selected wallets.
					await Promise.all(
						paymentContract.HotWallets.map(async (candidateWallet) => {
							const fresh = await prisma.hotWallet.findUnique({
								where: { id: candidateWallet.id, deletedAt: null },
								select: {
									pendingTransactionId: true,
									type: true,
									PendingTransaction: { select: { status: true, intendedTxHash: true, txHash: true } },
								},
							});
							if (fresh == null || fresh.type !== HotWalletType.Purchasing) return;
							// CRITICAL double-lock guard: only roll back + unlock a pending tx that
							// PROVABLY never broadcast (both hashes null — an unused placeholder or a
							// pre-submit failure). If a per-outcome revert above threw and jumped us
							// here while a sibling pairing had already succeeded (txHash set) or
							// returned submit-ambiguous (intendedTxHash set, txHash null, tx MAY be on
							// chain), rolling its shared tx back would hide it from
							// funding-reconciliation / tx-sync (both key on status: Pending) AND free
							// the wallet into a double-lock. Leave any tx with either hash set.
							const pendingTx = fresh.PendingTransaction;
							if (
								pendingTx != null &&
								pendingTx.status === TransactionStatus.Pending &&
								(pendingTx.intendedTxHash != null || pendingTx.txHash != null)
							) {
								logger.warn(
									'batch-payments outer-catch: preserving possibly-on-chain funding tx (leaving Pending + wallet locked)',
									{
										walletId: candidateWallet.id,
										pendingTransactionId: fresh.pendingTransactionId,
										hasTxHash: pendingTx.txHash != null,
										hasIntendedTxHash: pendingTx.intendedTxHash != null,
									},
								);
								return;
							}
							if (fresh.pendingTransactionId != null) {
								try {
									await prisma.transaction.update({
										where: { id: fresh.pendingTransactionId },
										data: { status: TransactionStatus.RolledBack },
									});
								} catch (rollbackError) {
									logger.warn('batch-payments outer-catch placeholder rollback failed (non-fatal)', {
										walletId: candidateWallet.id,
										placeholderId: fresh.pendingTransactionId,
										rollbackError: rollbackError instanceof Error ? rollbackError.message : rollbackError,
									});
								}
							}
							await prisma.hotWallet.update({
								where: { id: candidateWallet.id, deletedAt: null },
								data: {
									lockedAt: null,
									PendingTransaction: { disconnect: true },
								},
							});
						}),
					);

					await Promise.allSettled(
						failedPurchaseRequests.map(async (x) => {
							await prisma.purchaseRequest.update({
								where: { id: x.id },
								data: {
									ActionHistory: {
										connect: {
											id: x.nextActionId,
										},
									},
									NextAction: {
										create: {
											requestedAction: PurchasingAction.WaitingForManualAction,
											errorType: PurchaseErrorType.Unknown,
											errorNote: 'Outer error: Batching payments failed: ' + interpretBlockchainError(error),
										},
									},
								},
							});
						}),
					);

					// Revert the orphans collected above — after the wallet-unlock loop,
					// so the next tick never sees Requested while the wallet still holds
					// the placeholder.
					await Promise.allSettled(
						orphanedInitiatedRequests.map(async (r) => {
							await prisma.purchaseRequest.update({
								where: { id: r.id },
								data: {
									ActionHistory: {
										connect: { id: r.nextActionId },
									},
									NextAction: {
										create: {
											requestedAction: PurchasingAction.FundsLockingRequested,
											errorType: null,
											errorNote: null,
										},
									},
									CurrentTransaction: { disconnect: true },
									TransactionHistory: r.CurrentTransaction ? { connect: { id: r.CurrentTransaction.id } } : undefined,
								},
							});
						}),
					);
					throw error;
				}
			}),
		);
	} catch (error) {
		logger.error('Error batching payments', error);
	} finally {
		release?.();
	}
}
