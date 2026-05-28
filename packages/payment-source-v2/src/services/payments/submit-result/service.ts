import {
	OnChainState,
	PaymentAction,
	PaymentErrorType,
	PaymentSourceType,
	Prisma,
	TransactionStatus,
} from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { deserializeDatum, resolveTxHash, UTxO } from '@meshsdk/core';
import { isDefinitiveNodeRejection } from '../../submit-error-classifier';
import type { LanguageVersion } from '@meshsdk/core';
import { asV2Provider } from '../../provider-cast';
import type { BlockfrostProvider } from '@/services/shared';
import { logger } from '@masumi/payment-core/logger';
import { SmartContractState, smartContractStateEqualsOnChainState } from '@/utils/generator/contract-generator';
import { convertNetwork } from '@/utils/converter/network-convert';
import { DecodedV1ContractDatum, newCooldownTime } from '@/utils/converter/string-datum-convert';
import { lockAndQueryPayments } from '@/utils/db/lock-and-query-payments';
import { retryOnSerializationConflict } from '@/utils/db/retry';
import { withMeshCostModelLock } from '@/utils/mesh-cost-model-sync';
import { interpretBlockchainError } from '@/utils/errors/blockchain-error-interpreter';
import { sortAndLimitUtxos } from '@/utils/utxo';
import { delayErrorResolver } from 'advanced-retry';
import { advancedRetry } from 'advanced-retry';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { generateMasumiSmartContractInteractionTransactionAutomaticFees } from '@/utils/generator/transaction-generator';
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
import { decodeV2ContractDatum } from '@/utils/converter/string-datum-convert';
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

type MatchingUtxoResult = {
	utxo: UTxO;
	decodedContract: DecodedV1ContractDatum;
};

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

async function markRequestFailed(request: PaymentRequestWithRelations, error: unknown): Promise<void> {
	logger.error(`Error submitting V2 result ${request.id}`, { error });
	await prisma.paymentRequest.update({
		where: { id: request.id },
		data: {
			...connectPreviousAction(request.nextActionId),
			...createNextPaymentAction(PaymentAction.WaitingForManualAction, {
				// Carry forward the seller-supplied result hash so operator forensics
				// preserve the originally-attempted submission. Without this the
				// hash is lost when the request parks in WaitingForManualAction.
				resultHash: request.NextAction?.resultHash ?? null,
				errorType: PaymentErrorType.Unknown,
				errorNote: 'Submitting result failed: ' + interpretBlockchainError(error),
			}),
			SmartContractWallet: { update: { lockedAt: null } },
		},
	});
}

async function unlockHotWallet(walletId: string): Promise<void> {
	try {
		await prisma.hotWallet.update({
			where: { id: walletId, deletedAt: null },
			data: { lockedAt: null },
		});
	} catch (error) {
		logger.warn('Failed to unlock V2 submit-result hot wallet', { error, walletId });
	}
}

function findMatchingUtxoAndDecodeContract(
	utxoList: UTxO[],
	txHash: string,
	request: PaymentRequestWithRelations,
	paymentContract: PaymentSourceWithRelations,
): MatchingUtxoResult | undefined {
	for (const utxo of utxoList) {
		if (utxo.input.txHash !== txHash) {
			continue;
		}

		const utxoDatum = utxo.output.plutusData;
		if (!utxoDatum) {
			continue;
		}

		const decodedDatum: unknown = deserializeDatum(utxoDatum);
		const decodedContract = decodeV2ContractDatum(
			decodedDatum,
			convertNetwork(paymentContract.network),
			paymentContract.smartContractAddress,
		);
		if (decodedContract === null) {
			continue;
		}

		if (!smartContractStateEqualsOnChainState(decodedContract.state, request.onChainState)) {
			continue;
		}
		if (decodedContract.buyerVkey !== request.BuyerWallet!.walletVkey) {
			continue;
		}
		if (decodedContract.sellerVkey !== request.SmartContractWallet!.walletVkey) {
			continue;
		}
		if (decodedContract.buyerAddress !== request.BuyerWallet!.walletAddress) {
			continue;
		}
		if (decodedContract.sellerAddress !== request.SmartContractWallet!.walletAddress) {
			continue;
		}
		if (decodedContract.blockchainIdentifier !== request.blockchainIdentifier) {
			continue;
		}
		if (decodedContract.inputHash !== request.inputHash) {
			continue;
		}
		if (BigInt(decodedContract.resultTime) !== BigInt(request.submitResultTime)) {
			continue;
		}
		if (BigInt(decodedContract.unlockTime) !== BigInt(request.unlockTime)) {
			continue;
		}
		if (BigInt(decodedContract.externalDisputeUnlockTime) !== BigInt(request.externalDisputeUnlockTime)) {
			continue;
		}
		if (BigInt(decodedContract.collateralReturnLovelace) !== BigInt(request.collateralReturnLovelace!)) {
			continue;
		}
		if (BigInt(decodedContract.payByTime) !== BigInt(request.payByTime!)) {
			continue;
		}

		return { utxo, decodedContract };
	}

	return undefined;
}

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
	const matchResult = findMatchingUtxoAndDecodeContract(utxoByHash, txHash, request, paymentContract);
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
		constrainAfterMs: decodedContract.resultTime,
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
		const submitDeadlineMs = Number(request.submitResultTime);
		// Require a positive finite timestamp; treat 0/negative as a
		// data-integrity bug (deadline never set) rather than "passed".
		// Without the `> 0` guard, `Date.now() > 0` is always true and a
		// row with an uninitialised deadline silently falls into manual
		// intervention.
		if (Number.isFinite(submitDeadlineMs) && submitDeadlineMs > 0 && Date.now() > submitDeadlineMs) {
			throw new Error('Wallet empty and on-chain submitResultTime deadline passed; manual intervention required');
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

	const matchResult = findMatchingUtxoAndDecodeContract(utxoByHash, txHash, request, paymentContract);

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
		constrainAfterMs: decodedContract.resultTime,
		constrainBeforeMs: decodedContract.sellerCooldownTime,
	});

	const limitedUtxos = sortAndLimitUtxos(utxos, 8000000);

	const unsignedTx = await withMeshCostModelLock(
		paymentContract.PaymentSourceConfig.rpcProviderApiKey,
		async () =>
			await generateMasumiSmartContractInteractionTransactionAutomaticFees(
				'SubmitResult',
				blockchainProvider,
				network,
				script,
				address,
				utxo,
				limitedUtxos[0],
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

	await walletSession.evaluateProjectedBalance(unsignedTx, limitedUtxos);
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
				await markRequestFailed(request, error);
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
		const paymentContractsWithWalletLocked = await lockAndQueryPayments({
			paymentStatus: PaymentAction.SubmitResultRequested,
			// Aiken SubmitResult requires `must_end_before(submit_result_time)`.
			// The default tx-window's invalidAfter is ~now + 2.5min + slot buffer.
			// Filter to at least 5 minutes of slack so submissions don't race
			// the ledger boundary.
			submitResultTime: {
				gt: Date.now() + 1000 * 60 * 5,
			},
			requestedResultHash: { not: null },
			// Aiken `SubmitResult` is only legal from FundsLocked, ResultSubmitted,
			// RefundRequested, or Disputed (NOT from WithdrawAuthorized / RefundAuthorized).
			// `determineNewContractState` defers from the latter two anyway, but
			// pre-filtering here saves the lock + Blockfrost lookup cost on stale rows.
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
	} catch (error) {
		logger.error('Error submitting V2 result', { error });
	} finally {
		release();
	}
}
