import {
	OnChainState,
	PaymentAction,
	PaymentSourceType,
	Prisma,
	TransactionLayer,
	TransactionStatus,
} from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { resolveTxHash, UTxO } from '@meshsdk/core';
import { isDefinitiveNodeRejection } from '../../submit-error-classifier';
import { makeHotWalletUnlocker, makePaymentRequestFailureMarker } from '../../request-failure';
import { findMatchingPaymentUtxoWithContract } from '../../utxo-matching';
import type { LanguageVersion } from '@meshsdk/core';
import { asV2Provider } from '../../provider-cast';
import type { BlockfrostProvider } from '@/services/shared';
import { logger } from '@masumi/payment-core/logger';
import { recordV2BatchHashDivergence } from '@masumi/payment-core/metrics';
import { SmartContractState } from '@/utils/generator/contract-generator';
import { convertNetwork } from '@/utils/converter/network-convert';
import { DecodedV1ContractDatum, newCooldownTime } from '@/utils/converter/string-datum-convert';
import { lockAndQueryPayments } from '@/utils/db/lock-and-query-payments';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { withMeshCostModelLock } from '@/utils/mesh-cost-model-sync';
import { sortAndLimitUtxos } from '@/utils/utxo';
import { delayErrorResolver } from 'advanced-retry';
import { advancedRetry } from 'advanced-retry';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
// V2-pinned single-item builder. MUST NOT use the root V1-mesh generator
// (@/utils/generator/transaction-generator) — that bundles the V1 cost models
// and CBOR serializer, which produce a script-data-hash the ledger rejects for
// V2 scripts (PPViewHashesDontMatch). See docs/adr/0005.
import { generateMasumiSmartContractInteractionTransactionAutomaticFees } from '../../../builders/single-interaction';
import {
	connectExistingNextPaymentAction,
	connectExistingTransaction,
	connectPreviousAction,
	createMeshProvider,
	createNextPaymentAction,
	createPendingTransaction,
	createTxWindow,
	disconnectTransactionWallet,
	loadHotWalletSession,
	safeDeleteOrphanNextPaymentAction,
} from '@/services/shared';
import { createDatumFromDecodedContractV2, getPaymentScriptFromPaymentSourceV2 } from '@masumi/payment-source-v2';
import { headClockBehindCooldownMs, resolveHydraL2WindowOptions } from '@/utils/hydra/l2-slot-context';
import { syncMeshCostModelsFromHeadV2 } from '../../../utils/mesh-cost-model-sync';
import {
	assertNoCollateralOverlap,
	assertTxSizeWithinLimit,
	intersectTxWindows,
	pickBatchCollateral,
	shrinkBatchToFit,
	type TxWindowBounds,
	WALLET_SPLITTER_LOVELACE,
} from '../../../builders/batch-helpers';
import {
	type BatchInteractionItem,
	generateMasumiSmartContractBatchInteractionTransactionAutomaticFees,
} from '../../../builders/batch-interaction';
import { ensureCollateralReady } from '../../wallet-collateral/ensure-collateral-ready';
import { LOOKUP_DEFERRED_PREFIX, isLookupDeferred } from '../../lookup-defer';
import { fetchUTxOsWithDeferOnEmpty } from '../../utxo-fetch-helpers';
import { unlockHotWalletIfNoPendingTransaction } from '../../wallet-lock-helpers';

// V2 submit-result sizing. Each leg evaluates the Aiken `SubmitResult` redeemer
// over the same script; per-input ex-units run ~mem 4M / steps 1.5B in practice,
// so 6 fits well under the protocol max-ex-units even with headroom. The cap
// also matches the V2 register batch size for operational consistency.
const SUBMIT_RESULT_BATCH_SIZE = 7;

type PaymentSourceWithRelations = Prisma.PaymentSourceGetPayload<{
	include: {
		PaymentRequests: {
			include: {
				NextAction: true;
				CurrentTransaction: true;
				RequestedFunds: true;
				BuyerWallet: true;
				SmartContractWallet: {
					include: {
						Secret: true;
					};
				};
			};
		};
		AdminWallets: true;
		FeeReceiverNetworkWallet: true;
		PaymentSourceConfig: true;
	};
}>;

type PaymentRequestWithRelations = PaymentSourceWithRelations['PaymentRequests'][number];

type ValidatedSubmitItem = {
	request: PaymentRequestWithRelations;
	smartContractUtxo: UTxO;
	decodedContract: DecodedV1ContractDatum;
	newInlineDatum: ReturnType<typeof createDatumFromDecodedContractV2>['value'];
	window: TxWindowBounds;
};

// LOOKUP_DEFERRED_PREFIX / isLookupDeferred imported from ../../lookup-defer.
// Rationale (see lookup-defer.ts): batch services throw with the sentinel
// prefix to signal "skip this item, leave it in *Requested for the next tick"
// rather than parking in WaitingForManualAction. Authority for terminal
// transitions belongs to tx-sync; action services should never short-circuit
// chain-state inference based on a transient blockfrost miss.

// `fetchUTxOsWithDeferOnEmpty` is imported from ../../utxo-fetch-helpers — see
// that file for the retry/backoff rationale.

const mutex = new Mutex();

/**
 * Determine the new contract state for a SubmitResult transition.
 *
 * vested_pay.ak only permits SubmitResult from `FundsLocked`, `RefundRequested`,
 * `ResultSubmitted` (re-submit), or `Disputed` — see the validator's
 * SubmitResult branch. From `WithdrawAuthorized` / `RefundAuthorized` the
 * transition is rejected on chain, and from terminal-derived states the
 * UTxO has already been consumed.
 *
 * If tx-sync ever leaves a request row with `paymentStatus=SubmitResultRequested`
 * but the on-chain datum already advanced to an unrejected state, building the
 * batch tx with that item would phase-2-fail the WHOLE batch. Surface the
 * defer-sentinel here so the caller's catch arm routes the item to the queue
 * via the `info`-level defer log instead of marking it failed and dragging the
 * batch down.
 */
function determineNewContractState(currentState: SmartContractState): SmartContractState {
	switch (currentState) {
		case SmartContractState.Disputed:
		case SmartContractState.RefundRequested:
			return SmartContractState.Disputed;
		case SmartContractState.FundsLocked:
		case SmartContractState.ResultSubmitted:
			return SmartContractState.ResultSubmitted;
		case SmartContractState.WithdrawAuthorized:
		case SmartContractState.RefundAuthorized:
			throw new Error(
				`${LOOKUP_DEFERRED_PREFIX} SubmitResult not legal from on-chain state ${currentState} — request is stale, deferring to next tick`,
			);
		default: {
			// Exhaustiveness: a future SmartContractState added without updating this
			// switch should fail loudly rather than silently emit ResultSubmitted.
			const _exhaustive: never = currentState;
			throw new Error(
				`${LOOKUP_DEFERRED_PREFIX} SubmitResult: unknown on-chain state ${String(_exhaustive)} — deferring`,
			);
		}
	}
}

// Slack kept off each on-chain SubmitResult deadline. The default tx-window
// invalidAfter is ~now+2.5min+buffer; keeping ≥5min off the bound ensures a
// submission never races the ledger boundary (a tx whose invalidAfter lands
// after the bound is rejected by `must_end_before`).
const SUBMIT_RESULT_WINDOW_SLACK_MS = 1000 * 60 * 5;

/**
 * Pick the `constrainAfterMs` (upper-bound anchor) for the SubmitResult tx
 * validity window, matching the two legal time windows in vested_pay.ak's
 * `SubmitResult` redeemer:
 *
 *   A) Normal: tx must end before `submit_result_time`. Used while that deadline
 *      is still comfortably ahead.
 *   B) Dispute-window rotation: once past `submit_result_time`, the validator
 *      still accepts a re-submit as long as the tx ends before
 *      `external_dispute_unlock_time` AND the CURRENT on-chain datum already
 *      carries a result (`result_hash` non-empty — true for ResultSubmitted /
 *      Disputed). Anchor invalidAfter to `external_dispute_unlock_time` so the
 *      window is in the future. (The old code anchored unconditionally to
 *      `submit_result_time`; once that was in the past, createTxWindow's `min`
 *      strategy produced invalidAfter < invalidBefore — an unbuildable tx — so
 *      the dispute-rotation capability was dead off-chain.)
 *
 * Throws a terminal (non-deferred) error when neither window is open so the
 * caller marks the row for manual action rather than re-queueing it forever.
 */
function resolveSubmitResultConstrainAfterMs(decodedContract: DecodedV1ContractDatum, nowMs: number): bigint {
	const cutoff = BigInt(nowMs + SUBMIT_RESULT_WINDOW_SLACK_MS);
	if (decodedContract.resultTime > cutoff) {
		return decodedContract.resultTime;
	}
	if (decodedContract.resultHash != null && decodedContract.externalDisputeUnlockTime > cutoff) {
		return decodedContract.externalDisputeUnlockTime;
	}
	throw new Error(
		decodedContract.resultHash == null
			? 'SubmitResult window closed: past submit_result_time and no on-chain result to rotate during the dispute window; manual intervention required'
			: 'SubmitResult window closed: past both submit_result_time and external_dispute_unlock_time; manual intervention required',
	);
}

const markRequestFailed = makePaymentRequestFailureMarker({
	logMessage: 'Error submitting V2 result',
	errorNotePrefix: 'Submitting result failed: ',
	// Carry forward the seller-supplied result hash so operator forensics
	// preserve the originally-attempted submission. Without this the hash is
	// lost when the request parks in WaitingForManualAction.
	carryResultHash: true,
});

const unlockHotWallet = makeHotWalletUnlocker('submit-result');

/**
 * Per-request validation. Locates the matching script UTxO, decodes the on-chain
 * datum, builds the new continuation datum, and computes the per-item tx-window
 * bounds. Throws on validation failure — caller maps the throw to a per-request
 * failure update.
 */
async function validateAndBuildItem(
	request: PaymentRequestWithRelations,
	paymentContract: PaymentSourceWithRelations,
	blockchainProvider: BlockfrostProvider,
	network: 'mainnet' | 'preprod',
): Promise<ValidatedSubmitItem> {
	if (request.payByTime == null) {
		throw new Error('Pay by time is null, this is deprecated');
	}
	if (request.collateralReturnLovelace == null) {
		throw new Error('Collateral return lovelace is null, this is deprecated');
	}
	if (request.NextAction.resultHash == null) {
		throw new Error('Result hash is not set on NextAction');
	}
	const txHash = request.CurrentTransaction?.txHash;
	if (txHash == null) {
		throw new Error('No transaction hash found');
	}
	const utxoByHash = await fetchUTxOsWithDeferOnEmpty(blockchainProvider, txHash);
	const matchResult = findMatchingPaymentUtxoWithContract(
		utxoByHash,
		txHash,
		request,
		convertNetwork(paymentContract.network),
		paymentContract.smartContractAddress,
	);
	if (!matchResult) {
		throw new Error(`${LOOKUP_DEFERRED_PREFIX} UTXO not found`);
	}
	const { utxo, decodedContract } = matchResult;

	const datum = createDatumFromDecodedContractV2({
		decodedContract,
		buyerAddress: decodedContract.buyerAddress,
		sellerAddress: decodedContract.sellerAddress,
		blockchainIdentifier: request.blockchainIdentifier,
		resultHash: request.NextAction.resultHash,
		newCooldownTimeSeller: newCooldownTime(BigInt(paymentContract.cooldownTime)),
		newCooldownTimeBuyer: BigInt(0),
		state: determineNewContractState(decodedContract.state),
	});

	const { invalidBefore, invalidAfter } = createTxWindow(network, {
		// Branch A (submit_result_time) while the deadline is ahead, else branch B
		// (external_dispute_unlock_time) for dispute-window result rotation. See
		// resolveSubmitResultConstrainAfterMs.
		constrainAfterMs: resolveSubmitResultConstrainAfterMs(decodedContract, Date.now()),
		constrainBeforeMs: decodedContract.sellerCooldownTime,
	});

	return {
		request,
		smartContractUtxo: utxo,
		decodedContract,
		newInlineDatum: datum.value,
		window: { invalidBefore, invalidAfter },
	};
}

async function processSinglePaymentRequest(
	request: PaymentRequestWithRelations,
	paymentContract: PaymentSourceWithRelations,
	blockchainProvider: BlockfrostProvider,
	network: 'mainnet' | 'preprod',
): Promise<boolean> {
	if (request.payByTime == null) {
		throw new Error('Pay by time is null, this is deprecated');
	}
	if (request.collateralReturnLovelace == null) {
		throw new Error('Collateral return lovelace is null, this is deprecated');
	}
	const walletSession = await loadHotWalletSession({
		network: paymentContract.network,
		rpcProviderApiKey: paymentContract.PaymentSourceConfig.rpcProviderApiKey,
		encryptedMnemonic: request.SmartContractWallet!.Secret.encryptedMnemonic,
		hotWalletId: request.SmartContractWallet!.id,
	});
	const { wallet, utxos, address } = walletSession;

	if (utxos.length === 0) {
		// Wallet empty — check if the on-chain submission deadline has passed
		// before deferring. Aiken `SubmitResult` requires
		// `must_end_before(validity_range, submit_result_time)`, so past this
		// point the seller cannot submit anymore. Topup won't help; park for
		// manual intervention.
		// Effective give-up deadline. A ResultSubmitted / Disputed row can still
		// rotate its result during the dispute window (vested_pay.ak SubmitResult
		// branch B), so a topup could still let it submit up to
		// external_dispute_unlock_time. Other states only have the normal
		// submit_result_time deadline. Using the wrong bound here would force a
		// disputed row to manual action while it is still on-chain submittable.
		const canRotateInDispute =
			request.onChainState === OnChainState.ResultSubmitted || request.onChainState === OnChainState.Disputed;
		const submitDeadlineMs = canRotateInDispute
			? Number(request.externalDisputeUnlockTime)
			: Number(request.submitResultTime);
		// Require a positive finite timestamp; treat 0/negative as a
		// data-integrity bug (deadline never set) rather than "passed".
		// Without the `> 0` guard, `Date.now() > 0` is always true and a
		// row with an uninitialised deadline silently falls into manual
		// intervention.
		if (Number.isFinite(submitDeadlineMs) && submitDeadlineMs > 0 && Date.now() > submitDeadlineMs) {
			throw new Error(
				'Wallet empty and on-chain submit window (incl. dispute window) passed; manual intervention required',
			);
		}
		// Deadline still ahead — defer to wait for funder cron topup.
		throw new Error(`${LOOKUP_DEFERRED_PREFIX} wallet has no UTXOs; awaiting topup, retry next tick`);
	}

	// Same collateral-readiness gate as the batch path. Throw the
	// LOOKUP_DEFERRED sentinel when we are NOT ready so the
	// `fallbackToSingleItems` catch arm in this service routes the item
	// back to the queue (via the `info`-level defer log) instead of
	// calling markRequestFailed. The prep tx already locks the wallet
	// through its shared Tx row; we just need the caller to bail out
	// without consuming the slot.
	const collateralCheck = await ensureCollateralReady({
		walletDbId: request.SmartContractWallet!.id,
		walletAddress: address,
		meshWallet: wallet,
		utxos,
		blockchainProvider,
		network,
		serviceLabel: 'submit-result-single',
	});
	if (collateralCheck.status !== 'ready') {
		throw new Error(
			`${LOOKUP_DEFERRED_PREFIX} wallet not collateral-ready (${collateralCheck.status}); retry next tick`,
		);
	}

	const { script, smartContractAddress } = await getPaymentScriptFromPaymentSourceV2(paymentContract);
	const txHash = request.CurrentTransaction?.txHash;
	if (txHash == null) {
		throw new Error('No transaction hash found');
	}
	const utxoByHash = await fetchUTxOsWithDeferOnEmpty(blockchainProvider, txHash);

	const matchResult = findMatchingPaymentUtxoWithContract(
		utxoByHash,
		txHash,
		request,
		convertNetwork(paymentContract.network),
		paymentContract.smartContractAddress,
	);

	if (!matchResult) {
		throw new Error(`${LOOKUP_DEFERRED_PREFIX} UTXO not found`);
	}

	const { utxo, decodedContract } = matchResult;

	const datum = createDatumFromDecodedContractV2({
		decodedContract,
		buyerAddress: decodedContract.buyerAddress,
		sellerAddress: decodedContract.sellerAddress,
		blockchainIdentifier: request.blockchainIdentifier,
		resultHash: request.NextAction.resultHash,
		newCooldownTimeSeller: newCooldownTime(BigInt(paymentContract.cooldownTime)),
		newCooldownTimeBuyer: BigInt(0),
		state: determineNewContractState(decodedContract.state),
	});

	const { invalidBefore, invalidAfter } = createTxWindow(network, {
		// Branch A (submit_result_time) while the deadline is ahead, else branch B
		// (external_dispute_unlock_time) for dispute-window result rotation. See
		// resolveSubmitResultConstrainAfterMs.
		constrainAfterMs: resolveSubmitResultConstrainAfterMs(decodedContract, Date.now()),
		constrainBeforeMs: decodedContract.sellerCooldownTime,
	});

	const limitedUtxos = sortAndLimitUtxos(utxos, 8000000);
	// Collateral must cover the pinned 3 ADA total_collateral. limitedUtxos is
	// sorted by ASCENDING asset bloat, so [0] can be a pure-ADA DUST UTxO (< 3
	// ADA) → deterministic phase-1 InsufficientCollateral. Prefer the smallest
	// qualifying >= 5 ADA UTxO (the same floor the batch path enforces via
	// pickBatchCollateral); ensureCollateralReady above provisions a 5 ADA
	// reserve, so this normally succeeds. Fall back to [0] only if the wallet has
	// nothing larger (no worse than the previous behaviour).
	const collateralUtxo = pickBatchCollateral(limitedUtxos, [utxo.input]) ?? limitedUtxos[0];
	if (collateralUtxo == null) {
		throw new Error('Collateral UTXO not found');
	}

	const unsignedTx = await withMeshCostModelLock(
		paymentContract.PaymentSourceConfig.rpcProviderApiKey,
		async () =>
			await generateMasumiSmartContractInteractionTransactionAutomaticFees(
				'SubmitResult',
				// V2-pinned builder expects the V2 mesh provider type; cast the shared
				// (V1-resolved) instance — identical runtime object. See provider-cast.ts.
				asV2Provider(blockchainProvider),
				network,
				script,
				address,
				utxo,
				collateralUtxo,
				limitedUtxos,
				datum.value,
				invalidBefore,
				invalidAfter,
				paymentContract.PaymentSourceConfig.rpcProviderApiKey,
				// V2 single-item splitter — see authorize-refund/service.ts for rationale.
				WALLET_SPLITTER_LOVELACE,
			),
	);

	const signedTx = await wallet.signTx(unsignedTx);

	// Submit FIRST, then write DB. Previous order (DB row → submitTx) left an
	// orphan Pending Transaction row holding BlocksWallet → wallet whenever
	// submitTx threw: the catch arm cleared lockedAt but the Transaction stayed
	// Pending with txHash=null, keeping HotWallet.pendingTransactionId pointed
	// at it until wallet-timeouts swept it minutes later. With submit-first
	// there is no DB row to clean up on submit failure — the catch arm only
	// reverts NextAction + clears lockedAt, no orphan Tx to roll back.
	let newTxHash: string;
	try {
		newTxHash = await wallet.submitTx(signedTx);
	} catch (error) {
		logger.error(`Error submitting result`, { error: error });
		await prisma.paymentRequest.update({
			where: { id: request.id },
			data: {
				...connectPreviousAction(request.nextActionId),
				...createNextPaymentAction(PaymentAction.SubmitResultRequested, {
					errorType: null,
					errorNote: null,
					resultHash: request.NextAction.resultHash,
				}),
				SmartContractWallet: {
					update: {
						lockedAt: null,
					},
				},
			},
		});
		return false;
	}

	// Divergence check — parity with this service's batch path. submitTx's
	// returned hash must equal the deterministic resolveTxHash(signedTx); a
	// mismatch signals a Mesh/Cardano serialization bug. We keep newTxHash (it
	// is the hash the node accepted and what tx-sync will observe), but log
	// loudly so single-item submits are investigable like the batch path.
	const intendedTxHash = resolveTxHash(signedTx);
	if (newTxHash !== intendedTxHash) {
		logger.error('V2 submit-result single-item: node returned divergent txHash — investigate', {
			intendedTxHash,
			nodeTxHash: newTxHash,
		});
	}
	// Non-fatal post-submit balance check. The tx is already on chain; a throw
	// here (its low-balance fallback does uncaught DB work) must NOT propagate,
	// otherwise advancedRetry re-runs the whole build/sign/submit against the
	// now-consumed UTxO — conflicting re-submissions that end in manual action
	// with the successful tx's hash never recorded. The batch path already wraps
	// the identical call this way.
	try {
		await walletSession.evaluateProjectedBalance(unsignedTx, limitedUtxos);
	} catch (balanceError) {
		logger.warn('V2 submit-result single-item: projected-balance check failed post-submit (non-fatal)', {
			requestId: request.id,
			error: balanceError instanceof Error ? balanceError.message : balanceError,
		});
	}
	// Create the Transaction row with txHash already populated — single
	// update both transitions the action AND attaches the real on-chain
	// txHash. Any throw beyond this point leaves the Tx row in place (it
	// points at a real on-chain tx) per the user's "do NOT revert after
	// successful submit" constraint.
	// Wrapped in retryOnSerializationConflict — see the matching note in V2
	// collection's processSinglePaymentCollection (#24): a bare update can
	// leak a serialization conflict up to advancedRetry and cause a second
	// on-chain submit. Retry-then-give-up beats double-submit.
	await retryOnSerializationConflict(
		() =>
			prisma.paymentRequest.update({
				where: { id: request.id },
				data: {
					...connectPreviousAction(request.nextActionId),
					...createNextPaymentAction(PaymentAction.SubmitResultInitiated),
					...createPendingTransaction(request.SmartContractWallet!.id, newTxHash),
					TransactionHistory: {
						connect: {
							id: request.CurrentTransaction!.id,
						},
					},
				},
			}),
		{ label: 'v2-submit-result-single-post-submit' },
	);

	logger.debug(`Created submit result transaction:
                  Tx ID: ${newTxHash}
                  View (after a bit) on https://${
										network === 'preprod' ? 'preprod.' : ''
									}cardanoscan.io/transaction/${newTxHash}
                  Smart Contract Address: ${smartContractAddress}
              `);

	return true;
}

// ---------------------------------------------------------------------------
// Hydra L2 submit-result.
//
// In-head execution (cost models, validity window, collateral, fee model) was
// validated on a Hydra devnet (see docs/hydra-l2-devnet-findings.md). This mirrors
// the L1 single-item flow above but builds + submits against the Hydra head:
//   - wallet UTxOs come from the head snapshot (not Blockfrost),
//   - no L1 collateral-prep / topup / cost-model sync (the head's committed
//     UTxOs are the spendable set; the V2 builder bundles beta.102 cost models),
//   - the build runs through the V2 (beta.102) builder with the Hydra provider
//     as fetcher (isHydra) so the script-data-hash matches the V2 contract,
//   - submission goes to the head via provider.submitTx (not wallet.submitTx).
// The L1 path (processSinglePaymentRequest / processWalletBatch) is left
// untouched. This is the reference pattern for the other six V2 services.
// ---------------------------------------------------------------------------
async function processL2SubmitResult(
	request: PaymentRequestWithRelations,
	paymentContract: PaymentSourceWithRelations,
	network: 'mainnet' | 'preprod',
): Promise<boolean> {
	const headId = request.CurrentTransaction?.hydraHeadId;
	if (headId == null) {
		throw new Error('L2 submit-result: request has no hydraHeadId on CurrentTransaction');
	}
	const hydraProvider = getHydraConnectionManager().getProvider(headId);
	if (!hydraProvider) {
		throw new Error(`${LOOKUP_DEFERRED_PREFIX} no active Hydra provider for head ${headId}; retry next tick`);
	}

	// Wallet is loaded only for its signing key + address; its L1 UTxOs are
	// ignored — the spendable set lives in the head snapshot below.
	const walletSession = await loadHotWalletSession({
		network: paymentContract.network,
		rpcProviderApiKey: paymentContract.PaymentSourceConfig.rpcProviderApiKey,
		encryptedMnemonic: request.SmartContractWallet!.Secret.encryptedMnemonic,
		hotWalletId: request.SmartContractWallet!.id,
	});
	const { wallet, address } = walletSession;

	const headWalletUtxos = await hydraProvider.fetchAddressUTxOs(address);
	if (headWalletUtxos.length === 0) {
		throw new Error(`${LOOKUP_DEFERRED_PREFIX} L2 wallet has no UTxOs in head ${headId}; retry next tick`);
	}

	const { script, smartContractAddress } = await getPaymentScriptFromPaymentSourceV2(paymentContract);
	const txHash = request.CurrentTransaction?.txHash;
	if (txHash == null) {
		throw new Error('L2 submit-result: CurrentTransaction has no txHash');
	}

	const utxoByHash = await hydraProvider.fetchUTxOs(txHash);
	const matchResult = findMatchingPaymentUtxoWithContract(utxoByHash, txHash, request, network, smartContractAddress);
	if (!matchResult) {
		throw new Error(`${LOOKUP_DEFERRED_PREFIX} L2 contract UTXO not found in head`);
	}
	const { utxo, decodedContract } = matchResult;

	const datum = createDatumFromDecodedContractV2({
		decodedContract,
		buyerAddress: decodedContract.buyerAddress,
		sellerAddress: decodedContract.sellerAddress,
		blockchainIdentifier: request.blockchainIdentifier,
		resultHash: request.NextAction.resultHash,
		newCooldownTimeSeller: newCooldownTime(BigInt(paymentContract.cooldownTime)),
		newCooldownTimeBuyer: BigInt(0),
		state: determineNewContractState(decodedContract.state),
	});

	// L2 (in-head) txs are checked against the HEAD's slot timeline AND the
	// head's own (lagging) clock. Anchor the window to the head: env devnet
	// override (own slot config) or the live head Tick/SyncedStatusReport time
	// on a same-network head; empty options → network config + Date.now() as
	// before (no head clock observed yet).
	const l2WindowOptions = resolveHydraL2WindowOptions(hydraProvider);
	const headBehindMs = headClockBehindCooldownMs(l2WindowOptions, decodedContract.sellerCooldownTime);
	if (headBehindMs > 0) {
		throw new Error(
			`${LOOKUP_DEFERRED_PREFIX} head clock is ${Math.ceil(headBehindMs / 1000)}s behind the seller cooldown; retry next tick`,
		);
	}
	const { invalidBefore, invalidAfter } = createTxWindow(network, {
		constrainAfterMs: resolveSubmitResultConstrainAfterMs(decodedContract, l2WindowOptions.nowMs ?? Date.now()),
		constrainBeforeMs: decodedContract.sellerCooldownTime,
		...l2WindowOptions,
	});

	const limitedUtxos = sortAndLimitUtxos(headWalletUtxos, 8000000);
	const collateralUtxo = limitedUtxos[0];
	if (collateralUtxo == null) {
		throw new Error(`${LOOKUP_DEFERRED_PREFIX} L2 wallet has no collateral UTxO in head`);
	}

	// Bridge the V1-resolved Hydra provider into the V2 builder's type seam (see
	// asV2Provider / ADR-0005). Pass it as both the param-source provider AND the
	// L2 build provider; the latter triggers the isHydra build path and skips
	// Blockfrost fee evaluation.
	const hydraV2Provider = asV2Provider(hydraProvider);
	// Patch the V2 mesh line's bundled Plutus cost-model arrays from the HEAD's
	// protocol parameters before building. There is no Blockfrost evaluator on
	// L2, so syncMeshCostModelsFromChainV2 can't run; without the head's cost
	// models the in-head script-data-hash (computed in core-cst from those
	// arrays) won't match and the head rejects the tx with PPViewHashesDontMatch.
	// The arrays are process-global and shared with the L1 path, so hold the
	// per-payment-source mesh lock across sync + build + sign (submitTx stays
	// outside), exactly as the L1 path does. See docs/adr/0005.
	const headCostModels = await hydraProvider.fetchRawCostModels();
	const signedTx = await withMeshCostModelLock(paymentContract.PaymentSourceConfig.rpcProviderApiKey, async () => {
		await syncMeshCostModelsFromHeadV2(headCostModels);
		const unsignedTx = await generateMasumiSmartContractInteractionTransactionAutomaticFees(
			'SubmitResult',
			hydraV2Provider,
			network,
			script,
			address,
			utxo,
			collateralUtxo,
			limitedUtxos,
			datum.value,
			invalidBefore,
			invalidAfter,
			undefined, // rpcApiKey — no chain cost-model sync on L2
			undefined, // walletSplitterLovelace — L1-only convention
			hydraV2Provider, // hydraProvider → isHydra build path
		);
		return await wallet.signTx(unsignedTx);
	});

	let newTxHash: string;
	try {
		newTxHash = await hydraProvider.submitTx(signedTx);
	} catch (error) {
		logger.error('L2 submit-result: error submitting to head', { error, headId });
		await prisma.paymentRequest.update({
			where: { id: request.id },
			data: {
				...connectPreviousAction(request.nextActionId),
				...createNextPaymentAction(PaymentAction.SubmitResultRequested, {
					errorType: null,
					errorNote: null,
					resultHash: request.NextAction.resultHash,
				}),
				SmartContractWallet: { update: { lockedAt: null } },
			},
		});
		return false;
	}

	await retryOnSerializationConflict(
		() =>
			prisma.paymentRequest.update({
				where: { id: request.id },
				data: {
					...connectPreviousAction(request.nextActionId),
					...createNextPaymentAction(PaymentAction.SubmitResultInitiated),
					...createPendingTransaction(request.SmartContractWallet!.id, newTxHash, {
						layer: TransactionLayer.L2,
						hydraHeadId: headId,
					}),
					TransactionHistory: { connect: { id: request.CurrentTransaction!.id } },
				},
			}),
		{ label: 'v2-submit-result-l2-post-submit' },
	);

	logger.info('L2 submit-result submitted to head', { txHash: newTxHash, headId, smartContractAddress });
	return true;
}

async function fallbackToSingleItems(
	requests: PaymentRequestWithRelations[],
	paymentContract: PaymentSourceWithRelations,
	blockchainProvider: BlockfrostProvider,
	network: 'mainnet' | 'preprod',
): Promise<void> {
	// Process AT MOST ONE item, not all N. Submitting the first item
	// creates a PendingTransaction that locks the hot wallet, so any
	// subsequent item in this tick would just race the wallet lock and
	// fail. The remaining items stay in their queued state — next
	// scheduler tick (after tx-sync clears the lock) re-picks them up
	// and batches them again. The fallback exists purely so a single
	// bad item (invalid datum, expired window, etc.) does not block the
	// rest forever; it is NOT a parallel retry path. In the happy path
	// the batch builder above handles everything in one tx and this
	// function never runs.
	if (requests.length === 0) return;
	const request = requests[0];
	try {
		await advancedRetry({
			errorResolvers: [
				delayErrorResolver({
					configuration: {
						maxRetries: 5,
						backoffMultiplier: 5,
						initialDelayMs: 500,
						maxDelayMs: 7500,
					},
				}),
			],
			operation: async () => {
				const ok = await processSinglePaymentRequest(request, paymentContract, blockchainProvider, network);
				if (!ok) throw new Error('processSingle returned false');
				return ok;
			},
		});
	} catch (error) {
		if (isLookupDeferred(error)) {
			// Same defer-to-tx-sync semantics as the batch validation pass:
			// chain lookup miss is NOT a per-item failure; leave the request
			// queued and let tx-sync drive any terminal transition.
			logger.info(
				`Deferring V2 single-item fallback (chain lookup not ready); request ${request.id} stays queued for tx-sync to reconcile`,
				{ error: error instanceof Error ? error.message : error },
			);
		} else {
			await markRequestFailed(request, error);
		}
	}
	// requests[1..] are intentionally left untouched — they remain in
	// their `*Requested` state and the next tick (after the wallet
	// unlocks) will batch them again. Do NOT call markRequestFailed on
	// them here: a batch build failure caused by a transient issue
	// (network blip, blockfrost lag, cost-model sync race) is not a
	// per-item failure and the items deserve another chance.
}

async function processWalletBatch(
	requests: PaymentRequestWithRelations[],
	paymentContract: PaymentSourceWithRelations,
	blockchainProvider: BlockfrostProvider,
	network: 'mainnet' | 'preprod',
	script: { version: LanguageVersion; code: string },
	smartContractAddress: string,
): Promise<void> {
	const firstRequest = requests[0];
	const wallet = firstRequest.SmartContractWallet!;

	let walletSession;
	try {
		walletSession = await loadHotWalletSession({
			network: paymentContract.network,
			rpcProviderApiKey: paymentContract.PaymentSourceConfig.rpcProviderApiKey,
			encryptedMnemonic: wallet.Secret.encryptedMnemonic,
			hotWalletId: wallet.id,
		});
	} catch (error) {
		logger.warn(
			'V2 submit-result batch could not load wallet session; leaving items in pool for next tick [batch-fallback]',
			{
				error: error instanceof Error ? { message: error.message, stack: error.stack, name: error.name } : error,
				walletId: wallet.id,
				batchSize: requests.length,
			},
		);
		// Wallet-load failure is NOT a per-item failure: every request
		// in this batch was waiting on the same wallet. Marking them all
		// as `WaitingForManualAction` would terminate good requests for
		// a transient infra issue. Unlock the hot wallet and leave the
		// requests in their queued state — next tick (after the wallet
		// session loads cleanly) re-batches them.
		await unlockHotWallet(wallet.id);
		return;
	}
	const { wallet: meshWallet, utxos, address } = walletSession;
	if (utxos.length === 0) {
		logger.warn('V2 batch hot wallet returned no UTxOs; leaving items in pool for next tick [batch-fallback]', {
			walletId: wallet.id,
			batchSize: requests.length,
		});
		// Empty wallet is a transient operational issue (faucet ran out,
		// pending state still settling). NOT a per-item failure — leave
		// items queued for the next tick after the wallet has UTxOs.
		await unlockHotWallet(wallet.id);
		return;
	}

	const collateralCheck = await ensureCollateralReady({
		walletDbId: wallet.id,
		walletAddress: address,
		meshWallet,
		utxos,
		blockchainProvider,
		network,
		serviceLabel: 'submit-result-batch',
	});
	if (collateralCheck.status !== 'ready') {
		// Helper has either submitted a prep tx (deferred — wallet locked
		// until prep confirms) or hit insufficient_funds / prep_tx_failed.
		// Either way leave items queued and bail out of this tick.
		return;
	}

	// Per-request validation. Failures here become per-request DB failures and
	// are excluded from the batch.
	const validated: ValidatedSubmitItem[] = [];
	const deferredIds: string[] = [];
	const failedIds: string[] = [];
	for (const request of requests) {
		try {
			validated.push(await validateAndBuildItem(request, paymentContract, blockchainProvider, network));
		} catch (error) {
			if (isLookupDeferred(error)) {
				// Chain-lookup miss (blockfrost not caught up, or the UTxO
				// has already been consumed by something tx-sync has not
				// observed yet). Leave the request queued — tx-sync owns
				// the chain-state truth and will drive any terminal
				// transition. WARN-level so the CI grep captures it — this is
				// the most likely path for a 'stuck item' to enter, and we
				// need to be able to count defers per tick from the log dump.
				deferredIds.push(request.id);
				logger.warn('V2 submit-result: deferring item this tick (chain lookup not ready) [batch-diag]', {
					tickPhase: 'validate',
					requestId: request.id,
					blockchainIdentifier: request.blockchainIdentifier,
					walletId: wallet.id,
					currentTxHash: request.CurrentTransaction?.txHash ?? null,
					error: error instanceof Error ? error.message : error,
				});
			} else {
				failedIds.push(request.id);
				logger.warn('V2 submit-result: marking item as failed (non-defer error) [batch-diag]', {
					requestId: request.id,
					blockchainIdentifier: request.blockchainIdentifier,
					error: error instanceof Error ? { message: error.message, name: error.name } : error,
				});
				// Mid-batch: keep the shared wallet lock (see markRequestFailed).
				await markRequestFailed(request, error, { unlockWallet: false });
			}
		}
	}
	// WARN-level so CI grep captures it. This is the single most useful log
	// for diagnosing 'stuck item' failures in batch-verification e2e.
	logger.warn('V2 submit-result: per-item validation outcome [batch-diag]', {
		tickPhase: 'validate-summary',
		walletId: wallet.id,
		totalIn: requests.length,
		validatedCount: validated.length,
		deferredCount: deferredIds.length,
		failedCount: failedIds.length,
		validatedIds: validated.map((v) => v.request.blockchainIdentifier),
		deferredIds,
		failedIds,
		inboundIds: requests.map((r) => ({
			blockchainIdentifier: r.blockchainIdentifier,
			currentTxHash: r.CurrentTransaction?.txHash ?? null,
		})),
	});
	if (validated.length === 0) {
		logger.info(
			'No V2 submit-result items in this tick reached the batch builder (every item was either deferred for tx-sync to reconcile or marked failed); leaving wallet unlocked',
			{ walletId: wallet.id, deferredIds, failedIds },
		);
		await unlockHotWallet(wallet.id);
		return;
	}

	// Pick collateral that is NOT in the spending set.
	const excludeRefs = validated.map((v) => v.smartContractUtxo.input);
	const collateralUtxo = pickBatchCollateral(utxos, excludeRefs);
	if (collateralUtxo == null) {
		logger.warn('V2 submit-result batch could not find collateral UTxO; falling back to single-item [batch-fallback]', {
			walletId: wallet.id,
		});
		await fallbackToSingleItems(
			validated.map((v) => v.request),
			paymentContract,
			blockchainProvider,
			network,
		);
		return;
	}

	const spendingUtxoKeys = new Set(
		validated.map((v) => `${v.smartContractUtxo.input.txHash}#${v.smartContractUtxo.input.outputIndex}`),
	);
	const collateralKey = `${collateralUtxo.input.txHash}#${collateralUtxo.input.outputIndex}`;
	const walletUtxos = utxos.filter((utxo) => {
		const key = `${utxo.input.txHash}#${utxo.input.outputIndex}`;
		if (key === collateralKey) return false;
		if (spendingUtxoKeys.has(key)) return false;
		return true;
	});
	const limitedFilteredUtxos = sortAndLimitUtxos(walletUtxos, 8000000);

	// Constraints applied progressively: validity-window intersection then
	// no-collateral-overlap. tx-size is checked after the build pass.
	const shrinkResult = shrinkBatchToFit(validated, (subset) => {
		const window = intersectTxWindows(subset.map((v) => v.window));
		if (window == null) {
			return { ok: false, reason: 'window' };
		}
		try {
			assertNoCollateralOverlap(
				collateralUtxo,
				subset.map((v) => ({ input: v.smartContractUtxo.input })),
			);
		} catch {
			return { ok: false, reason: 'collateral' };
		}
		return { ok: true };
	});

	if (shrinkResult.fit.length === 0) {
		logger.warn(
			'V2 submit-result batch could not satisfy batch invariants; falling back to single-item [batch-fallback]',
			{
				reason: shrinkResult.reason,
				walletId: wallet.id,
			},
		);
		await fallbackToSingleItems(
			validated.map((v) => v.request),
			paymentContract,
			blockchainProvider,
			network,
		);
		return;
	}
	if (shrinkResult.dropped.length > 0) {
		logger.warn(
			`V2 submit-result batch shrunk from ${validated.length} to ${shrinkResult.fit.length} (reason=${shrinkResult.reason})`,
		);
	}

	const fit = shrinkResult.fit;
	const droppedRequests = shrinkResult.dropped.map((v) => v.request);

	// Composed window from the surviving subset.
	const composed = intersectTxWindows(fit.map((v) => v.window));
	if (composed == null) {
		// shrinkBatchToFit invariant says this can't happen for fit.length > 0,
		// but be defensive.
		logger.error('V2 submit-result composed window is null after shrink — falling back', { walletId: wallet.id });
		await fallbackToSingleItems(
			validated.map((v) => v.request),
			paymentContract,
			blockchainProvider,
			network,
		);
		return;
	}

	const items: BatchInteractionItem[] = fit.map((v) => ({
		type: 'SubmitResult',
		smartContractUtxo: v.smartContractUtxo,
		newInlineDatum: v.newInlineDatum,
	}));

	let unsignedTx: string;
	try {
		// See note on cross-mesh-version type alias in
		// packages/payment-source-v2/src/services/registry/deregister/service.ts.
		unsignedTx = await withMeshCostModelLock(
			paymentContract.PaymentSourceConfig.rpcProviderApiKey,
			async () =>
				await generateMasumiSmartContractBatchInteractionTransactionAutomaticFees(
					asV2Provider(blockchainProvider),
					network,
					script,
					address,
					collateralUtxo,
					limitedFilteredUtxos,
					items,
					composed.invalidBefore,
					composed.invalidAfter,
					paymentContract.PaymentSourceConfig.rpcProviderApiKey,
				),
		);
		assertTxSizeWithinLimit(unsignedTx, 'v2-submit-result-batch');
	} catch (batchError) {
		logger.warn('V2 submit-result batch build failed; falling back to single-item [batch-fallback]', {
			error:
				batchError instanceof Error
					? { message: batchError.message, stack: batchError.stack, name: batchError.name }
					: batchError,
			batchSize: fit.length,
			walletId: wallet.id,
		});
		await fallbackToSingleItems(
			validated.map((v) => v.request),
			paymentContract,
			blockchainProvider,
			network,
		);
		return;
	}

	let signedTx: string;
	try {
		signedTx = await meshWallet.signTx(unsignedTx);
	} catch (signError) {
		logger.warn('V2 submit-result batch sign failed; falling back to single-item [batch-fallback]', {
			error:
				signError instanceof Error
					? { message: signError.message, stack: signError.stack, name: signError.name }
					: signError,
			walletId: wallet.id,
		});
		await fallbackToSingleItems(
			validated.map((v) => v.request),
			paymentContract,
			blockchainProvider,
			network,
		);
		return;
	}

	// V2 batch shared-Transaction pre-submit:
	// 1. Create ONE Transaction row carrying BlocksWallet → wallet.
	// 2. Connect every fit item's CurrentTransaction to that shared Tx.
	// This replaces the N-orphan pattern (one createPendingTransaction per
	// item) — HotWallet.pendingTransactionId points to the single shared Tx,
	// so tx-sync's BlocksWallet-driven wallet unlock fires exactly once per
	// batch regardless of which entry it processes first.
	let sharedTxId: string;
	// Captured per-request Initiated NextAction ids; used by the rollback path
	// below to safely delete the orphan rows without risking accidental deletion
	// of someone else's history entry (see safeDeleteOrphanNextPaymentAction).
	const initiatedByRequestId = new Map<string, string>();
	try {
		sharedTxId = await retryOnSerializationConflict(
			() =>
				prisma.$transaction(
					async (tx) => {
						initiatedByRequestId.clear();
						const sharedTx = await tx.transaction.create({
							data: {
								status: TransactionStatus.Pending,
								// `lastCheckedAt: now` required so wallet-timeouts can poll this row.
								// See docs/adr/0006 and docs/adr/0007 for the full rationale.
								lastCheckedAt: new Date(),
								BlocksWallet: { connect: { id: wallet.id } },
							},
						});
						for (const v of fit) {
							// Explicit create-then-connect so we know the new *Initiated row's id.
							// The default `createNextPaymentAction` does a nested create whose id
							// isn't directly returned; we need it to safely clean up orphans on
							// rollback (see #6 audit-trail leak design).
							const initiated = await tx.paymentActionData.create({
								data: { requestedAction: PaymentAction.SubmitResultInitiated },
							});
							await tx.paymentRequest.update({
								where: { id: v.request.id },
								data: {
									...connectPreviousAction(v.request.nextActionId),
									...connectExistingNextPaymentAction(initiated.id),
									...connectExistingTransaction(sharedTx.id),
									TransactionHistory: { connect: { id: v.request.CurrentTransaction!.id } },
								},
							});
							initiatedByRequestId.set(v.request.id, initiated.id);
						}
						return sharedTx.id;
					},
					{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
				),
			{ label: 'submit-result-batch-tx' },
		);
	} catch (dbError) {
		logger.error('V2 submit-result batch DB pre-submit update failed', { error: dbError });
		await unlockHotWallet(wallet.id);
		return;
	}

	// Defensive: record `intendedTxHash` + `invalidHereafterSlot` on the
	// shared Transaction row BEFORE broadcast. If submit later throws
	// AMBIGUOUSLY (transport error, 5xx, timeout — unknown chain outcome)
	// we leave the row Pending; funding-reconciliation resolves it by
	// querying the chain for `intendedTxHash` once `invalidHereafterSlot`
	// has passed. Without the hash recorded, reconciliation cannot resolve
	// and the Pending row sits until wallet-timeouts forces a manual sweep.
	// See batch-payments service header for the full invariant.
	const intendedTxHash = resolveTxHash(signedTx);
	const invalidHereafterSlot = composed.invalidAfter;
	let recordIntentFailed = false;
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
			{ label: 'submit-result-batch-record-intended' },
		);
	} catch (recordError) {
		logger.error('V2 submit-result batch could not record intendedTxHash; will rollback pre-submit DB', {
			sharedTxId,
			intendedTxHash,
			error: recordError instanceof Error ? recordError.message : recordError,
		});
		recordIntentFailed = true;
	}

	let newTxHash: string;
	try {
		if (recordIntentFailed) {
			// Skip broadcast and go to rollback. We have NOT submitted, so DB
			// rollback is safe and the rollback branch below handles it.
			throw new Error('PRE_SUBMIT_RECORD_INTENT_FAILED');
		}
		newTxHash = await meshWallet.submitTx(signedTx);
	} catch (submitError) {
		// Classify: definitive node rejection → safe to rollback DB state.
		// Ambiguous (transport error, network glitch, 5xx) → tx body may be
		// on chain. Leave the shared Transaction Pending with intendedTxHash
		// set; funding-reconciliation resolves once chain reports
		// definitively (found → promote, not-found AND past
		// invalidHereafterSlot → RolledBack).
		// recordIntentFailed forces the rollback branch (we never broadcast).
		const definitive = recordIntentFailed || isDefinitiveNodeRejection(submitError);
		if (!definitive) {
			logger.warn('V2 submit-result batch submit AMBIGUOUS; leaving Pending for reconciliation', {
				sharedTxId,
				intendedTxHash,
				invalidHereafterSlot,
				error:
					submitError instanceof Error
						? { message: submitError.message, stack: submitError.stack, name: submitError.name }
						: submitError,
			});
			// Wallet stays locked; PendingTransaction stays attached. The
			// funding-reconciliation worker handles the row from here.
			return;
		}
		logger.warn('V2 submit-result batch submit definitively rejected; rolling back DB and retrying as single items', {
			error:
				submitError instanceof Error
					? { message: submitError.message, stack: submitError.stack, name: submitError.name }
					: submitError,
		});
		await retryOnSerializationConflict(
			() =>
				prisma.$transaction(
					async (tx) => {
						await tx.transaction.update({
							where: { id: sharedTxId },
							data: {
								...disconnectTransactionWallet(),
								// Mark the orphan shared row as RolledBack: the per-item reverts
								// below restore each request's CurrentTransaction to its pre-batch
								// value, leaving this row with no back-references. Without an
								// explicit status update it would sit in `Pending` indefinitely
								// (no wallet pointer → invisible to wallet-timeouts; no request
								// pointer → invisible to tx-sync), accumulating as DB pollution.
								status: TransactionStatus.RolledBack,
							},
						});
						for (const v of fit) {
							// Skip+log rather than bang-then-throw: a throw here would roll back the
							// shared-Tx revert above. lockedAt is handled separately by the
							// post-fallbackToSingleItems unlockHotWalletIfNoPendingTransaction.
							const currentTxId = v.request.CurrentTransaction?.id;
							if (currentTxId == null) {
								logger.error(
									`V2 submit-result rollback: request ${v.request.id} missing CurrentTransaction; skipping item revert`,
								);
								continue;
							}
							// Drift check: confirm the request's NextAction is still OUR *Initiated.
							// If another worker advanced it (manual recovery, concurrent tick),
							// LEAVE THE ROW ALONE — don't revert state and don't delete the
							// Initiated row. Conservative: better to leak the row than corrupt
							// someone else's history. See #6 audit-trail leak design.
							const expectedInitiatedId = initiatedByRequestId.get(v.request.id);
							const fresh = await tx.paymentRequest.findUnique({
								where: { id: v.request.id },
								select: { nextActionId: true },
							});
							if (expectedInitiatedId == null || fresh == null || fresh.nextActionId !== expectedInitiatedId) {
								logger.warn(
									'V2 submit-result rollback: nextAction drifted after pre-submit; leaving Initiated row, skipping revert',
									{
										requestId: v.request.id,
										expectedInitiatedId,
										actualNextAction: fresh?.nextActionId,
									},
								);
								continue;
							}
							await tx.paymentRequest.update({
								where: { id: v.request.id },
								data: {
									// NOTE: NO connectPreviousAction(v.request.nextActionId) here.
									// Pre-submit already wrote the OLD *Requested into ActionHistory;
									// re-running would be a no-op (Prisma `connect` semantics on a
									// many-to-many) and is misleading.
									...createNextPaymentAction(PaymentAction.SubmitResultRequested, {
										errorType: null,
										errorNote: null,
										resultHash: v.request.NextAction.resultHash,
									}),
									CurrentTransaction: { connect: { id: currentTxId } },
									TransactionHistory: { disconnect: { id: currentTxId } },
								},
							});
							// Safely delete the orphan *Initiated row created in pre-submit.
							// The helper re-verifies inside this Serializable tx that the row
							// has zero incoming references; if it does, it leaks the row and
							// returns reason. Caller logs at WARN — leaking a row is a minor
							// audit drift; deleting one referenced elsewhere is corruption.
							const result = await safeDeleteOrphanNextPaymentAction(tx, expectedInitiatedId);
							if (!result.deleted) {
								logger.warn('V2 submit-result rollback: leaked orphan Initiated row (refused to delete)', {
									requestId: v.request.id,
									orphanActionId: expectedInitiatedId,
									reason: result.reason,
								});
							}
						}
					},
					{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
				),
			{ label: 'submit-result-batch-tx' },
		);
		await fallbackToSingleItems(
			validated.map((v) => v.request),
			paymentContract,
			blockchainProvider,
			network,
		);
		// Rollback only cleared pendingTransactionId; lockedAt stays set. Conditional
		// unlock prevents the wallet from orphan-locking when every single-item fallback
		// deferred — preserves the lock when a single-item submit succeeded.
		await unlockHotWalletIfNoPendingTransaction(wallet.id, 'submit-result-batch-rollback');
		return;
	}

	// Divergence check: if mesh returned a hash different from the
	// deterministically-computed intendedTxHash, the tx IS still on chain at
	// the node-returned hash (the node is authoritative), but the discrepancy
	// signals a hash-computation drift — investigate cost-model staleness,
	// mesh-version drift, or protocol-parameter desync. Log loudly and bump
	// the dedicated metric for alerting.
	if (newTxHash !== intendedTxHash) {
		logger.error('V2 submit-result batch: node returned divergent txHash — investigate', {
			sharedTxId,
			intendedTxHash,
			nodeTxHash: newTxHash,
			requestIds: fit.map((v) => v.request.id),
		});
		recordV2BatchHashDivergence('submit-result', { source_id: paymentContract.id });
	}

	try {
		await walletSession.evaluateProjectedBalance(unsignedTx, limitedFilteredUtxos);
	} catch (balanceError) {
		logger.warn('V2 submit-result batch projected balance evaluation failed (non-fatal)', {
			error:
				balanceError instanceof Error
					? { message: balanceError.message, stack: balanceError.stack, name: balanceError.name }
					: balanceError,
		});
	}

	// Post-submit: a SINGLE Transaction row carries the txHash for the whole
	// batch (because pre-submit created one shared Tx referenced by every
	// participating PaymentRequest). One update suffices.
	try {
		await retryOnSerializationConflict(
			() =>
				prisma.$transaction(
					async (tx) => {
						await tx.transaction.update({
							where: { id: sharedTxId },
							data: { txHash: newTxHash },
						});
					},
					{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
				),
			{ label: 'submit-result-batch-tx' },
		);
	} catch (dbError) {
		logger.error('V2 submit-result batch post-submit DB update failed; tx-sync will reconcile next tick', {
			error:
				dbError instanceof Error ? { message: dbError.message, stack: dbError.stack, name: dbError.name } : dbError,
			txHash: newTxHash,
		});
	}

	// WARN-level so CI grep captures it. Single source of truth for what
	// landed in the on-chain tx vs what got left behind this tick.
	logger.warn('V2 submit-result: batch submitted [batch-diag]', {
		tickPhase: 'submitted',
		walletId: wallet.id,
		newTxHash,
		sharedTxId,
		fitCount: fit.length,
		fitIds: fit.map((v) => v.request.blockchainIdentifier),
		droppedCount: droppedRequests.length,
		droppedIds: droppedRequests.map((r) => r.blockchainIdentifier),
		deferredIds,
		failedIds,
	});

	logger.debug(`Created V2 submit-result batch transaction:
              Tx ID: ${newTxHash}
              Items: ${fit.length}
              View on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${newTxHash}
              Smart Contract Address: ${smartContractAddress}
          `);

	if (droppedRequests.length > 0) {
		// Items that were peeled off should be retried via single-item next
		// tick. Mark as failed-and-retryable so the scheduler can pick them up.
		await Promise.allSettled(
			droppedRequests.map((request) =>
				prisma.paymentRequest.update({
					where: { id: request.id },
					data: {
						...connectPreviousAction(request.nextActionId),
						...createNextPaymentAction(PaymentAction.SubmitResultRequested, {
							errorType: null,
							errorNote: null,
							resultHash: request.NextAction.resultHash,
						}),
					},
				}),
			),
		);
	}
}

function groupRequestsByWallet(requests: PaymentRequestWithRelations[]): Map<string, PaymentRequestWithRelations[]> {
	const byWallet = new Map<string, PaymentRequestWithRelations[]>();
	for (const request of requests) {
		if (request.SmartContractWallet == null) continue;
		const list = byWallet.get(request.SmartContractWallet.id) ?? [];
		list.push(request);
		byWallet.set(request.SmartContractWallet.id, list);
	}
	return byWallet;
}

export async function submitResultV2() {
	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch (e) {
		logger.info('Mutex timeout when locking', { error: e });
		return;
	}

	try {
		const nowMs = Date.now();
		const paymentContractsWithWalletLocked = await lockAndQueryPayments({
			paymentStatus: PaymentAction.SubmitResultRequested,
			requestedResultHash: { not: null },
			// vested_pay.ak `SubmitResult` accepts a tx in EITHER of two windows
			// (and only from FundsLocked / ResultSubmitted / RefundRequested /
			// Disputed — never WithdrawAuthorized / RefundAuthorized, which
			// determineNewContractState defers anyway):
			//
			//   A) Normal pre-deadline submit — tx ends before submit_result_time.
			//   B) Dispute-window result rotation — tx ends before
			//      external_dispute_unlock_time AND the current on-chain datum
			//      already carries a result (i.e. ResultSubmitted or Disputed).
			//
			// Each leg keeps ≥5min slack off its own boundary (default tx-window
			// invalidAfter is ~now+2.5min+buffer) so a submission never races the
			// ledger bound. resolveSubmitResultConstrainAfterMs picks the matching
			// upper bound per row at build time; this OR only gates eligibility.
			// (Previously only leg A was queried, so disputed rows past
			// submit_result_time were never selected and the contract's
			// dispute-rotation path was unreachable off-chain.)
			orFilters: [
				{
					submitResultTime: { gt: nowMs + SUBMIT_RESULT_WINDOW_SLACK_MS },
					onChainState: {
						in: [
							OnChainState.FundsLocked,
							OnChainState.ResultSubmitted,
							OnChainState.RefundRequested,
							OnChainState.Disputed,
						],
					},
				},
				{
					submitResultTime: { lte: nowMs + SUBMIT_RESULT_WINDOW_SLACK_MS },
					externalDisputeUnlockTime: { gt: nowMs + SUBMIT_RESULT_WINDOW_SLACK_MS },
					onChainState: { in: [OnChainState.ResultSubmitted, OnChainState.Disputed] },
				},
			],
			maxBatchSize: SUBMIT_RESULT_BATCH_SIZE,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
			// L1 only — Hydra L2 requests are handled by the dedicated single-item
			// head path below (processL2SubmitResult).
			layer: TransactionLayer.L1,
		});

		await Promise.allSettled(
			paymentContractsWithWalletLocked.map(async (paymentContract) => {
				if (paymentContract.PaymentRequests.length == 0) return;

				logger.info(
					`Submitting ${paymentContract.PaymentRequests.length} V2 results for payment source ${paymentContract.id}`,
				);

				const network = convertNetwork(paymentContract.network);
				const blockchainProvider = await createMeshProvider(paymentContract.PaymentSourceConfig.rpcProviderApiKey);
				const { script, smartContractAddress } = await getPaymentScriptFromPaymentSourceV2(paymentContract);

				const grouped = groupRequestsByWallet(paymentContract.PaymentRequests);
				await Promise.allSettled(
					Array.from(grouped.values()).map(async (walletRequests) => {
						if (walletRequests.length === 0) return;
						await processWalletBatch(
							walletRequests,
							paymentContract,
							blockchainProvider,
							network,
							script,
							smartContractAddress,
						);
					}),
				);
			}),
		);

		// --- Hydra L2: dedicated single-item head path (reference service) ---
		// Eligibility uses a simpler onChainState gate than the L1 orFilters above;
		// in-head timing windows differ. Validated on a Hydra devnet (see
		// docs/hydra-l2-devnet-findings.md). The wallet lock still serializes
		// per-wallet L2 submits.
		const l2PaymentContracts = await lockAndQueryPayments({
			paymentStatus: PaymentAction.SubmitResultRequested,
			requestedResultHash: { not: null },
			onChainState: {
				in: [
					OnChainState.FundsLocked,
					OnChainState.ResultSubmitted,
					OnChainState.RefundRequested,
					OnChainState.Disputed,
				],
			},
			maxBatchSize: SUBMIT_RESULT_BATCH_SIZE,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
			layer: TransactionLayer.L2,
		});
		await Promise.allSettled(
			l2PaymentContracts.map(async (paymentContract) => {
				if (paymentContract.PaymentRequests.length === 0) return;
				const network = convertNetwork(paymentContract.network);
				await Promise.allSettled(
					paymentContract.PaymentRequests.map(async (request) => {
						try {
							await processL2SubmitResult(request, paymentContract, network);
						} catch (error) {
							if (isLookupDeferred(error)) {
								logger.info('L2 submit-result deferred to next tick', { requestId: request.id, error });
							} else {
								logger.error('L2 submit-result failed', { requestId: request.id, error });
							}
						}
					}),
				);
			}),
		);
	} catch (error) {
		logger.error('Error submitting V2 result', { error });
	} finally {
		release?.();
	}
}
