import { OnChainState, PaymentSourceType, Prisma, PurchasingAction, TransactionLayer } from '@/generated/prisma/client';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { convertNetwork } from '@/utils/converter/network-convert';
import { DecodedV1ContractDatum } from '@/utils/converter/string-datum-convert';
import { lockAndQueryPurchases } from '@/utils/db/lock-and-query-purchases';
import { headClockBehindCooldownMs, resolveHydraL2WindowOptions } from '@/utils/hydra/l2-slot-context';
import { withMeshCostModelLock } from '@/utils/mesh-cost-model-sync';
import { pickCollateralUtxo, sortAndLimitUtxos } from '@/utils/utxo';
import { logger } from '@masumi/payment-core/logger';
import { deserializeDatum, UTxO } from '@meshsdk/core';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { syncMeshCostModelsFromHeadV2 } from '../../../utils/mesh-cost-model-sync';
import { asV2Provider } from '../../provider-cast';
import { findMatchingPurchaseUtxo } from '../../utxo-matching';
// V2-pinned single-item builder. MUST NOT use the root V1-mesh generator (@/utils/generator/transaction-generator) — that bundles the V1 cost models and CBOR serializer, which produce a script-data-hash the ledger rejects for V2 scripts (PPViewHashesDontMatch). See docs/adr/0005.
import { createMeshProvider, createTxWindow, loadHotWalletSession } from '@/services/shared';
import { decodeV2ContractDatum } from '@/utils/converter/string-datum-convert';
import { createDatumFromDecodedContractV2, getPaymentScriptFromPaymentSourceV2 } from '@masumi/payment-source-v2';
import { type TxWindowBounds } from '../../../builders/batch-helpers';
import { generateMasumiSmartContractInteractionTransactionAutomaticFees } from '../../../builders/single-interaction';
import {
	clearL2RequestAttempts,
	deferredL2RequestIds,
	NO_PROGRESS_NOTE,
	standDownL2Request,
} from '../../l2-queue-rotation';
import { submitReservedL2Action } from '../../l2-submission';
import { isLookupDeferred, LOOKUP_DEFERRED_PREFIX } from '../../lookup-defer';
import { COLLATERAL_RESERVE_LOVELACE } from '../../wallet-collateral/ensure-collateral-ready';
import { unlockHotWalletIfNoPendingTransaction } from '../../wallet-lock-helpers';

import { processWalletBatch } from './batch';
import { createAuthorizeWithdrawalDatum, markRequestFailed, validatePurchaseRequestFields } from './single';

const AUTHORIZE_WITHDRAWAL_BATCH_SIZE = 7;

export type PaymentSourceWithPurchaseRelations = Prisma.PaymentSourceGetPayload<{
	include: {
		PurchaseRequests: {
			include: {
				NextAction: true;
				CurrentTransaction: true;
				PaidFunds: true;
				SellerWallet: true;
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

export type PurchaseRequestWithRelations = PaymentSourceWithPurchaseRelations['PurchaseRequests'][number];

export type ValidatedAuthorizeWithdrawalItem = {
	request: PurchaseRequestWithRelations;
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

function groupRequestsByWallet(requests: PurchaseRequestWithRelations[]): Map<string, PurchaseRequestWithRelations[]> {
	const byWallet = new Map<string, PurchaseRequestWithRelations[]>();
	for (const request of requests) {
		if (request.SmartContractWallet == null) continue;
		const list = byWallet.get(request.SmartContractWallet.id) ?? [];
		list.push(request);
		byWallet.set(request.SmartContractWallet.id, list);
	}
	return byWallet;
}

/**
 * Hydra L2 single-item authorize-withdrawal (in-head). Spends the contract UTxO
 * in the head and writes the WithdrawAuthorized continuation, mirroring the L1
 * single-item path on mesh 102 via `asV2Provider` with synchronous head submit.
 * Validated on a Hydra devnet (see docs/hydra-l2-devnet-findings.md).
 */
async function processL2AuthorizeWithdrawal(
	request: PurchaseRequestWithRelations,
	paymentContract: PaymentSourceWithPurchaseRelations,
	network: 'mainnet' | 'preprod',
): Promise<boolean> {
	const headId = request.CurrentTransaction?.hydraHeadId;
	if (headId == null) {
		throw new Error('L2 authorize-withdrawal: request has no hydraHeadId on CurrentTransaction');
	}
	const hydraProvider = getHydraConnectionManager().getProvider(headId);
	if (!hydraProvider) {
		throw new Error(`${LOOKUP_DEFERRED_PREFIX} no active Hydra provider for head ${headId}; retry next tick`);
	}
	validatePurchaseRequestFields(request);
	const purchasingWallet = request.SmartContractWallet!;

	const walletSession = await loadHotWalletSession({
		network: paymentContract.network,
		rpcProviderApiKey: paymentContract.PaymentSourceConfig.rpcProviderApiKey,
		encryptedMnemonic: purchasingWallet.Secret.encryptedMnemonic,
		hotWalletId: purchasingWallet.id,
	});
	const { wallet, address } = walletSession;

	const headWalletUtxos = await hydraProvider.spendableUTxOs(await hydraProvider.fetchAddressUTxOs(address));
	if (headWalletUtxos.length === 0) {
		throw new Error(`${LOOKUP_DEFERRED_PREFIX} L2 wallet has no UTxOs in head ${headId}; retry next tick`);
	}

	const { script, smartContractAddress } = await getPaymentScriptFromPaymentSourceV2(paymentContract);
	const txHash = request.CurrentTransaction?.txHash;
	if (txHash == null) {
		throw new Error('L2 authorize-withdrawal: CurrentTransaction has no txHash');
	}

	const utxoByHash = await hydraProvider.fetchUTxOs(txHash);
	const utxo = findMatchingPurchaseUtxo(utxoByHash, txHash, request, network, smartContractAddress);
	if (!utxo) {
		throw new Error(`${LOOKUP_DEFERRED_PREFIX} L2 contract UTXO not found in head`);
	}
	const utxoDatum = utxo.output.plutusData;
	if (!utxoDatum) {
		throw new Error(`${LOOKUP_DEFERRED_PREFIX} L2 no datum found in UTXO`);
	}
	const decodedDatum: unknown = deserializeDatum(utxoDatum);
	const decodedContract = decodeV2ContractDatum(decodedDatum, network, smartContractAddress);
	if (decodedContract == null) {
		throw new Error(`${LOOKUP_DEFERRED_PREFIX} L2 invalid datum`);
	}

	// L2: anchor the validity window to the head's clock (env devnet override or
	// live head Tick/SyncedStatusReport); the head's ledger clock can lag L1
	// wall-clock by more than the default window buffers.
	const l2WindowOptions = resolveHydraL2WindowOptions(hydraProvider);
	const headBehindMs = headClockBehindCooldownMs(l2WindowOptions, decodedContract.buyerCooldownTime);
	if (headBehindMs > 0) {
		throw new Error(
			`${LOOKUP_DEFERRED_PREFIX} head clock is ${Math.ceil(headBehindMs / 1000)}s behind the cooldown expiry; retry next tick`,
		);
	}
	const { invalidBefore, invalidAfter, invalidAfterMs } = createTxWindow(network, {
		constrainBeforeMs: decodedContract.buyerCooldownTime,
		...l2WindowOptions,
	});
	const datum = createAuthorizeWithdrawalDatum({
		decodedContract,
		buyerAddress: decodedContract.buyerAddress,
		sellerAddress: decodedContract.sellerAddress,
		blockchainIdentifier: request.blockchainIdentifier,
		cooldownTime: BigInt(paymentContract.cooldownTime),
		windowUpperMs: invalidAfterMs,
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

	const hydraV2Provider = asV2Provider(hydraProvider);
	// Patch the V2 mesh line's bundled Plutus cost-model arrays from the HEAD's
	// protocol parameters before building (no Blockfrost evaluator on L2). Without
	// the head's cost models the in-head script-data-hash won't match and the head
	// rejects with PPViewHashesDontMatch. Arrays are process-global + shared with
	// L1, so hold the per-payment-source mesh lock across sync + build + sign;
	// submitTx stays outside. See docs/adr/0005.
	const headCostModels = await hydraProvider.fetchRawCostModels();
	const signedTx = await withMeshCostModelLock(paymentContract.PaymentSourceConfig.rpcProviderApiKey, async () => {
		await syncMeshCostModelsFromHeadV2(headCostModels);
		const unsignedTx = await generateMasumiSmartContractInteractionTransactionAutomaticFees(
			'AuthorizeWithdrawal',
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
			hydraV2Provider,
		);
		return await wallet.signTx(unsignedTx);
	});

	const outcome = await submitReservedL2Action({
		requestKind: 'purchase',
		operation: 'authorize-withdrawal',
		requestId: request.id,
		nextActionId: request.nextActionId,
		previousTransactionId: request.CurrentTransaction!.id,
		walletId: purchasingWallet.id,
		walletLockedAt: purchasingWallet.lockedAt!,
		hydraHeadId: headId,
		signedTx,
		initiatedAction: PurchasingAction.AuthorizeWithdrawalInitiated,
		retryAction: PurchasingAction.AuthorizeWithdrawalRequested,
		submitTx: async (transaction) => await hydraProvider.submitTx(transaction),
	});

	// Only a never-dispatched command rolls back now. Keep the legacy outcome
	// check for compatibility; the executor never emits it. A node rejection
	// stays ambiguous and keeps the reservation for reconciliation.
	return outcome.status !== 'definitively-rejected' && outcome.status !== 'not-dispatched';
}

/** The L2 portion of the AuthorizeWithdrawal cycle, shared by the timer and the on-demand run. */
async function runAuthorizeWithdrawalL2Pass(): Promise<void> {
	// --- Hydra L2: dedicated single-item head authorize-withdrawal path ---
	// In-head timing differs from L1; validated on a Hydra devnet
	// (see docs/hydra-l2-devnet-findings.md).
	const l2PaymentContracts = await lockAndQueryPurchases({
		purchasingAction: PurchasingAction.AuthorizeWithdrawalRequested,
		onChainState: { in: [OnChainState.Disputed] },
		// One wallet can own only one durable L2 reservation at a time.
		maxBatchSize: 1,
		paymentSourceType: PaymentSourceType.Web3CardanoV2,
		layer: TransactionLayer.L2,
		// A request that just deferred stands aside for a moment so the rest of
		// its wallet's queue can move.
		excludeRequestIds: deferredL2RequestIds(),
	});
	await Promise.allSettled(
		l2PaymentContracts.map(async (paymentContract) => {
			if (paymentContract.PurchaseRequests.length === 0) return;
			const network = convertNetwork(paymentContract.network);
			await Promise.allSettled(
				paymentContract.PurchaseRequests.map(async (request) => {
					try {
						const progressed = await processL2AuthorizeWithdrawal(request, paymentContract, network);
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
						if (isLookupDeferred(error)) {
							logger.info('L2 authorize-withdrawal deferred to next tick', { requestId: request.id, error });
						} else {
							logger.error('L2 authorize-withdrawal failed', { requestId: request.id, error });
						}
						// Stood down for a cooldown, whichever it was. This pass takes the
						// oldest eligible request per wallet, so one that fails every tick —
						// a request carrying an unresolved terminal hash never matches its
						// UTxO again — would be picked forever while every other escrow on
						// that wallet waited behind it. The stand-down grows each time, and
						// a request that never gets past it is parked for an operator
						// rather than retried until its deadline passes.
						await standDownL2Request(request.id, () => markRequestFailed(request, error, { unlockWallet: false }));
						await unlockHotWalletIfNoPendingTransaction(
							request.SmartContractWallet!.id,
							'authorize-withdrawal-l2-pre-reservation',
							request.SmartContractWallet!.lockedAt!,
						);
					}
				}),
			);
		}),
	);
}

/**
 * The head path on its own, so it can run the moment the work appears.
 *
 * Same reasoning as the other head passes: L1 is batched because the chain
 * paces it, while this finishes in under a second inside an open head. Running
 * the whole cycle early would drag the L1 pass forward with it.
 */
export async function authorizeWithdrawalsL2V2(): Promise<void> {
	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch {
		logger.info('authorize_withdrawals_v2 is already running, skipping the on-demand L2 pass');
		return;
	}

	try {
		await runAuthorizeWithdrawalL2Pass();
	} catch (error) {
		logger.error('Error in the on-demand AuthorizeWithdrawal L2 pass', { error });
	} finally {
		release?.();
	}
}

export async function authorizeWithdrawalsV2() {
	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch {
		logger.info('authorize_withdrawal_v2 is already running, skipping cycle');
		return;
	}

	try {
		const paymentContractsWithWalletLocked = await lockAndQueryPurchases({
			purchasingAction: PurchasingAction.AuthorizeWithdrawalRequested,
			onChainState: { in: [OnChainState.Disputed] },
			maxBatchSize: AUTHORIZE_WITHDRAWAL_BATCH_SIZE,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
			layer: TransactionLayer.L1,
		});

		await Promise.allSettled(
			paymentContractsWithWalletLocked.map(async (paymentContract) => {
				if (paymentContract.PurchaseRequests.length == 0) return;

				const network = convertNetwork(paymentContract.network);
				logger.info(
					`Authorizing ${paymentContract.PurchaseRequests.length} V2 withdrawals for payment source ${paymentContract.id}`,
				);
				const blockchainProvider = await createMeshProvider(paymentContract.PaymentSourceConfig.rpcProviderApiKey);
				const { script, smartContractAddress } = await getPaymentScriptFromPaymentSourceV2(paymentContract);

				const grouped = groupRequestsByWallet(paymentContract.PurchaseRequests);
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

		await runAuthorizeWithdrawalL2Pass();
	} catch (error) {
		logger.error('Error authorizing V2 withdrawals', { error });
	} finally {
		release?.();
	}
}
