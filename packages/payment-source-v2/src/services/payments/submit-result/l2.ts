import { OnChainState, PaymentAction, PaymentSourceType, TransactionLayer } from '@/generated/prisma/client';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { findMatchingPaymentUtxoWithContract } from '../../utxo-matching';
import { asV2Provider } from '../../provider-cast';
import { logger } from '@masumi/payment-core/logger';
import { convertNetwork } from '@/utils/converter/network-convert';
import { newCooldownTime } from '@/utils/converter/string-datum-convert';
import { isRequestedResultOnChain } from '@/utils/logic/result-on-chain';
import { finishL2SubmitAlreadyOnChain } from './already-on-chain';
import { lockAndQueryPayments } from '@/utils/db/lock-and-query-payments';
import { withMeshCostModelLock } from '@/utils/mesh-cost-model-sync';
import { pickCollateralUtxo, sortAndLimitUtxos } from '@/utils/utxo';
// V2-pinned single-item builder. MUST NOT use the root V1-mesh generator
// (@/utils/generator/transaction-generator) — that bundles the V1 cost models
// and CBOR serializer, which produce a script-data-hash the ledger rejects for
// V2 scripts (PPViewHashesDontMatch). See docs/adr/0005.
import { generateMasumiSmartContractInteractionTransactionAutomaticFees } from '../../../builders/single-interaction';
import { createTxWindow, loadHotWalletSession } from '@/services/shared';
import { createDatumFromDecodedContractV2, getPaymentScriptFromPaymentSourceV2 } from '@masumi/payment-source-v2';
import { headClockBehindCooldownMs, resolveHydraL2WindowOptions } from '@/utils/hydra/l2-slot-context';
import { syncMeshCostModelsFromHeadV2 } from '../../../utils/mesh-cost-model-sync';
import { COLLATERAL_RESERVE_LOVELACE } from '../../wallet-collateral/ensure-collateral-ready';
import { LOOKUP_DEFERRED_PREFIX, isLookupDeferred } from '../../lookup-defer';
import {
	NO_PROGRESS_NOTE,
	clearL2RequestAttempts,
	deferredL2RequestIds,
	standDownL2Request,
} from '../../l2-queue-rotation';
import { unlockHotWalletIfNoPendingTransaction } from '../../wallet-lock-helpers';
import { submitReservedL2Action } from '../../l2-submission';
import { determineNewContractState } from './contract-state';
import { markRequestFailed } from './failure';
import type { PaymentRequestWithRelations, PaymentSourceWithRelations } from './types';
import { resolveSubmitResultConstrainAfterMs, SubmitResultWindowClosedError } from './window';

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

	const headWalletUtxos = hydraProvider.spendableUTxOs(await hydraProvider.fetchAddressUTxOs(address));
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

	if (isRequestedResultOnChain(decodedContract, request.NextAction.resultHash)) {
		await finishL2SubmitAlreadyOnChain(request, txHash);
		return true;
	}

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
	const { invalidBefore, invalidAfter, invalidAfterMs } = createTxWindow(network, {
		constrainAfterMs: resolveSubmitResultConstrainAfterMs(decodedContract, l2WindowOptions.nowMs ?? Date.now()),
		constrainBeforeMs: decodedContract.sellerCooldownTime,
		...l2WindowOptions,
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

	const limitedUtxos = sortAndLimitUtxos(headWalletUtxos, 8000000);
	// Collateral is chosen the way every other rail chooses it: by value, with a
	// floor. `limitedUtxos[0]` is ordered by asset count and has no floor at all,
	// so the buyer's own lock change — pure ADA, sitting at the 2 ADA minimum —
	// won whenever its reference sorted first. The builder declares 3 ADA of
	// total collateral regardless, which makes the collateral-return output
	// negative: the head refuses the body, every retry rebuilds the same one, and
	// that escrow can no longer be collected, refunded or authorized in the head.
	const collateralUtxo = pickCollateralUtxo(headWalletUtxos, COLLATERAL_RESERVE_LOVELACE);
	if (collateralUtxo == null) {
		throw new Error(`${LOOKUP_DEFERRED_PREFIX} L2 wallet has no collateral UTxO of at least 5 ADA in head`);
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

	const outcome = await submitReservedL2Action({
		requestKind: 'payment',
		operation: 'submit-result',
		requestId: request.id,
		nextActionId: request.nextActionId,
		previousTransactionId: request.CurrentTransaction!.id,
		walletId: request.SmartContractWallet!.id,
		walletLockedAt: request.SmartContractWallet!.lockedAt!,
		hydraHeadId: headId,
		signedTx,
		initiatedAction: PaymentAction.SubmitResultInitiated,
		// Stamped on both, the same as the two L1 paths. An ambiguous or
		// db-pending submit parks the request in `SubmitResultInitiated` holding
		// its reservation, and the action row is what an operator resolving that
		// by hand reads — with no hash on it, the one thing needed to reconstruct
		// what was being submitted was missing exactly where recovery is manual.
		initiatedActionData: { resultHash: request.NextAction.resultHash },
		retryAction: PaymentAction.SubmitResultRequested,
		retryActionData: { resultHash: request.NextAction.resultHash },
		submitTx: async (transaction) => await hydraProvider.submitTx(transaction),
	});

	// Only a never-dispatched command rolls back now. Keep the legacy outcome
	// check for compatibility; the executor never emits it. A node rejection
	// stays ambiguous and keeps the reservation for reconciliation.
	return outcome.status !== 'definitively-rejected' && outcome.status !== 'not-dispatched';
}

/** The L2 portion of the submit-result cycle, shared by the timer and the nudge. */
export async function runSubmitResultL2Pass(): Promise<void> {
	// --- Hydra L2: dedicated single-item head path (reference service) ---
	// Eligibility uses a simpler onChainState gate than the L1 orFilters above;
	// in-head timing windows differ. Validated on a Hydra devnet (see
	// docs/hydra-l2-devnet-findings.md). The wallet lock still serializes
	// per-wallet L2 submits.
	const l2PaymentContracts = await lockAndQueryPayments({
		paymentStatus: PaymentAction.SubmitResultRequested,
		requestedResultHash: { not: null },
		onChainState: {
			in: [OnChainState.FundsLocked, OnChainState.ResultSubmitted, OnChainState.RefundRequested, OnChainState.Disputed],
		},
		// The L2 path reserves one body against one wallet. Selecting multiple
		// requests for the same locked wallet would build them concurrently even
		// though only one can atomically claim pendingTransactionId.
		maxBatchSize: 1,
		paymentSourceType: PaymentSourceType.Web3CardanoV2,
		layer: TransactionLayer.L2,
		// A request that just deferred stands aside for a moment so the rest of
		// its wallet's queue can move.
		excludeRequestIds: deferredL2RequestIds(),
	});
	await Promise.allSettled(
		l2PaymentContracts.map(async (paymentContract) => {
			if (paymentContract.PaymentRequests.length === 0) return;
			const network = convertNetwork(paymentContract.network);
			await Promise.allSettled(
				paymentContract.PaymentRequests.map(async (request) => {
					try {
						const progressed = await processL2SubmitResult(request, paymentContract, network);
						if (progressed) {
							clearL2RequestAttempts(request.id);
						} else {
							// Rolled back rather than thrown, so the deferral in the catch
							// arm below never saw it. Without this the same request is the
							// oldest eligible row on this wallet every tick, is refused
							// again, and every escrow behind it runs out its deadlines.
							await standDownL2Request(request.id, () =>
								markRequestFailed(request, new Error(NO_PROGRESS_NOTE), { unlockWallet: false }),
							);
						}
					} catch (error) {
						// Spelled out rather than passed as an object: an Error serialises to
						// `{}` here, so every failure in this path logged as "L2
						// submit-result failed {}" and said nothing about why.
						const reason = error instanceof Error ? error.message : String(error);
						if (error instanceof SubmitResultWindowClosedError) {
							// Park it. Retrying cannot help, and this pass takes one
							// request per wallet — so leaving it eligible meant picking the
							// same doomed request every round while everything behind it
							// waited, until their deadlines passed too.
							logger.warn('L2 submit-result window closed; parking for manual action', {
								requestId: request.id,
								reason,
							});
							await markRequestFailed(request, error);
							return;
						}
						if (isLookupDeferred(error)) {
							logger.info('L2 submit-result deferred to next tick', { requestId: request.id, reason });
						} else {
							logger.error('L2 submit-result failed', {
								requestId: request.id,
								reason,
								stack: error instanceof Error ? error.stack?.slice(0, 1200) : undefined,
							});
						}
						// Same head-of-line reasoning as the window-closed park above, for
						// the failures that do not announce themselves as terminal: one
						// request per wallet per tick means a request that fails every tick
						// holds the whole queue behind it. The stand-down grows each time,
						// and one that never clears is parked rather than retried until the
						// submission window closes on it too.
						await standDownL2Request(request.id, () => markRequestFailed(request, error, { unlockWallet: false }));
						await unlockHotWalletIfNoPendingTransaction(
							request.SmartContractWallet!.id,
							'submit-result-l2-pre-reservation',
							request.SmartContractWallet!.lockedAt!,
						);
					}
				}),
			);
		}),
	);
}
