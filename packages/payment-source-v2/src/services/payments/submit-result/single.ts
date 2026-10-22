import { OnChainState, PaymentAction } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { resolveTxHash } from '@meshsdk/core';
import { logger } from '@masumi/payment-core/logger';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { delayErrorResolver } from 'advanced-retry';
import { advancedRetry } from 'advanced-retry';
import { findMatchingPaymentUtxoWithContract } from '../../utxo-matching';
import { asV2Provider } from '../../provider-cast';
import type { BlockfrostProvider } from '@/services/shared';
import { convertNetwork } from '@/utils/converter/network-convert';
import { newCooldownTime } from '@/utils/converter/string-datum-convert';
import { withMeshCostModelLock } from '@/utils/mesh-cost-model-sync';
// V2-pinned single-item builder. MUST NOT use the root V1-mesh generator
// (@/utils/generator/transaction-generator) — that bundles the V1 cost models
// and CBOR serializer, which produce a script-data-hash the ledger rejects for
// V2 scripts (PPViewHashesDontMatch). See docs/adr/0005.
import { generateMasumiSmartContractInteractionTransactionAutomaticFees } from '../../../builders/single-interaction';
import {
	connectPreviousAction,
	createNextPaymentAction,
	createPendingTransaction,
	createTxWindow,
	loadHotWalletSession,
} from '@/services/shared';
import { createDatumFromDecodedContractV2, getPaymentScriptFromPaymentSourceV2 } from '@masumi/payment-source-v2';
import { pickBatchCollateral, WALLET_SPLITTER_LOVELACE } from '../../../builders/batch-helpers';
import { ensureCollateralReady } from '../../wallet-collateral/ensure-collateral-ready';
import { LOOKUP_DEFERRED_PREFIX, isLookupDeferred } from '../../lookup-defer';
import { fetchUTxOsWithDeferOnEmpty } from '../../utxo-fetch-helpers';
import { determineNewContractState } from './contract-state';
import { markRequestFailed } from './failure';
import type { PaymentRequestWithRelations, PaymentSourceWithRelations } from './types';
import { resolveSubmitResultConstrainAfterMs } from './window';

/**
 * The L1 single-item path: one request built, signed and submitted on its own.
 * Runs only as the batch path's fallback, and handles at most one request per tick.
 */

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

	const { invalidBefore, invalidAfter, invalidAfterMs } = createTxWindow(network, {
		// Branch A (submit_result_time) while the deadline is ahead, else branch B
		// (external_dispute_unlock_time) for dispute-window result rotation. See
		// resolveSubmitResultConstrainAfterMs.
		constrainAfterMs: resolveSubmitResultConstrainAfterMs(decodedContract, Date.now()),
		constrainBeforeMs: decodedContract.sellerCooldownTime,
	});
	const datum = createDatumFromDecodedContractV2({
		decodedContract,
		buyerAddress: decodedContract.buyerAddress,
		sellerAddress: decodedContract.sellerAddress,
		blockchainIdentifier: request.blockchainIdentifier,
		resultHash: request.NextAction.resultHash,
		newCooldownTimeSeller: newCooldownTime(BigInt(paymentContract.cooldownTime), invalidAfterMs),
		newCooldownTimeBuyer: BigInt(0),
		state: determineNewContractState(decodedContract.state),
	});

	const collateralUtxo = pickBatchCollateral(utxos, [utxo.input]);
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
				utxos,
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
		await walletSession.evaluateProjectedBalance(unsignedTx, utxos);
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
					...createNextPaymentAction(PaymentAction.SubmitResultInitiated, {
						resultHash: request.NextAction.resultHash,
					}),
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

export async function fallbackToSingleItems(
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
