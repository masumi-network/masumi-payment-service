import { PurchasingAction, Prisma, TransactionStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { UTxO, resolveTxHash } from '@meshsdk/core';
import type { BlockfrostProvider, MeshWallet } from '@/services/shared';
import { Transaction } from '@/services/shared';
import { logger } from '@masumi/payment-core/logger';
import { SmartContractState } from '@/utils/generator/contract-generator';
import { convertNetwork } from '@/utils/converter/network-convert';
import { type BalanceMap, walletLowBalanceMonitorService } from '@/services/wallets';
import {
	connectExistingTransaction,
	connectPreviousAction,
	createNextPurchaseAction,
	createTxWindow,
} from '@/services/shared';
import { createDatumFromBlockchainIdentifierV2 } from '@masumi/payment-source-v2';
import { isDefinitiveNodeRejection } from '@masumi/payment-core/submit-error-classifier';
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

export type PaymentSourceWithWallets = Prisma.PaymentSourceGetPayload<{
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

export type PurchaseRequestWithRelations = PaymentSourceWithWallets['PurchaseRequests'][number];

export type BatchedRequest = {
	paymentRequest: PurchaseRequestWithRelations;
	overpaidLovelace: bigint;
};

export type WalletPairing = {
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

/** The escrow datum for one batched purchase; the buyer is the pairing hot wallet. */
export function batchLockDatum(walletPairing: WalletPairing, data: BatchedRequest) {
	const wallet = walletPairing.wallet;
	const buyerAddress = wallet.getUsedAddress().toBech32() as string;
	const sellerAddress = data.paymentRequest.SellerWallet.walletAddress;
	const submitResultTime = data.paymentRequest.submitResultTime;
	const unlockTime = data.paymentRequest.unlockTime;
	const externalDisputeUnlockTime = data.paymentRequest.externalDisputeUnlockTime;
	const buyerReturnAddress = data.paymentRequest.buyerReturnAddress ?? walletPairing.collectionAddress;

	if (data.paymentRequest.payByTime == null) {
		throw new Error('Pay by time is null, this is deprecated');
	}

	return createDatumFromBlockchainIdentifierV2({
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
}

/**
 * Move every batched purchase onto the shared Transaction row before submit.
 * Returns that row id.
 */
export async function recordBatchPresubmit(walletPairing: WalletPairing): Promise<string> {
	const walletId = walletPairing.walletId;
	const batchedRequests = walletPairing.batchedRequests;
	return await retryOnSerializationConflict(
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
}

/** Record the intended hash, submit, and classify the outcome (see the invariant above). */
export async function submitBatchTx(params: {
	walletPairing: WalletPairing;
	sharedTxId: string;
	signedTx: string;
	completeTx: string;
	invalidAfter: number;
	requestIds: string[];
}): Promise<BatchPairingOutcome> {
	const { walletPairing, sharedTxId, signedTx, completeTx, invalidAfter, requestIds } = params;
	const wallet = walletPairing.wallet;
	const walletId = walletPairing.walletId;
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

export async function executeSpecificBatchPayment(
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
		const datum = batchLockDatum(walletPairing, data);
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
	const sharedTxId = await recordBatchPresubmit(walletPairing);

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

	return submitBatchTx({ walletPairing, sharedTxId, signedTx, completeTx, invalidAfter, requestIds });
}
