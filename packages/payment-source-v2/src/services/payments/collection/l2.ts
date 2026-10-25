import { OnChainState, PaymentAction, PaymentSourceType, TransactionLayer } from '@/generated/prisma/client';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import type { BlockfrostProvider } from '@/services/shared';
import { convertNetwork } from '@/utils/converter/network-convert';
import { lockAndQueryPayments } from '@/utils/db/lock-and-query-payments';
import { resolveHydraL2WindowOptions } from '@/utils/hydra/l2-slot-context';
import { withMeshCostModelLock } from '@/utils/mesh-cost-model-sync';
import { pickCollateralUtxo, sortAndLimitUtxos } from '@/utils/utxo';
import { logger } from '@masumi/payment-core/logger';
import { syncMeshCostModelsFromHeadV2 } from '../../../utils/mesh-cost-model-sync';
import { asV2Provider } from '../../provider-cast';
// V2-pinned single-item builder. MUST NOT use the root V1-mesh generator
// (@/utils/generator/transaction-generator) — that bundles the V1 cost models
// and CBOR serializer, which produce a script-data-hash the ledger rejects for
// V2 scripts (PPViewHashesDontMatch). See docs/adr/0005.
import { loadHotWalletSession } from '@/services/shared';
import { getPaymentScriptFromPaymentSourceV2 } from '@masumi/payment-source-v2';
import { generateMasumiSmartContractWithdrawTransactionAutomaticFees } from '../../../builders/single-interaction';
import {
	NO_PROGRESS_NOTE,
	clearL2RequestAttempts,
	deferredL2RequestIds,
	standDownL2Request,
} from '../../l2-queue-rotation';
import { submitReservedL2Action } from '../../l2-submission';
import { LOOKUP_DEFERRED_PREFIX, isLookupDeferred } from '../../lookup-defer';
import { COLLATERAL_RESERVE_LOVELACE } from '../../wallet-collateral/ensure-collateral-ready';
import { unlockHotWalletIfNoPendingTransaction } from '../../wallet-lock-helpers';

import {
	markRequestFailed,
	validateAndBuildItem,
	type PaymentRequestWithRelations,
	type PaymentSourceWithRelations,
} from './single';

/**
 * Hydra L2 single-item collection (in-head withdraw). Spends the contract UTxO
 * in the head and pays the seller (and collateral return), mirroring the L1
 * single-item path but on mesh 102 via `asV2Provider` with synchronous head
 * submit. Validated on a Hydra devnet (see docs/hydra-l2-devnet-findings.md).
 */
async function processL2Collection(
	request: PaymentRequestWithRelations,
	paymentContract: PaymentSourceWithRelations,
	network: 'mainnet' | 'preprod',
): Promise<boolean> {
	const headId = request.CurrentTransaction?.hydraHeadId;
	if (headId == null) {
		throw new Error('L2 collection: request has no hydraHeadId on CurrentTransaction');
	}
	const hydraProvider = getHydraConnectionManager().getProvider(headId);
	if (!hydraProvider) {
		throw new Error(`${LOOKUP_DEFERRED_PREFIX} no active Hydra provider for head ${headId}; retry next tick`);
	}
	if (request.SmartContractWallet == null) {
		throw new Error('Smart contract wallet not found');
	}

	const walletSession = await loadHotWalletSession({
		network: paymentContract.network,
		rpcProviderApiKey: paymentContract.PaymentSourceConfig.rpcProviderApiKey,
		encryptedMnemonic: request.SmartContractWallet.Secret.encryptedMnemonic,
		hotWalletId: request.SmartContractWallet.id,
	});
	const { wallet, address } = walletSession;

	const headWalletUtxos = await hydraProvider.spendableUTxOs(await hydraProvider.fetchAddressUTxOs(address));
	if (headWalletUtxos.length === 0) {
		throw new Error(`${LOOKUP_DEFERRED_PREFIX} L2 wallet has no UTxOs in head ${headId}; retry next tick`);
	}

	const { script, smartContractAddress } = await getPaymentScriptFromPaymentSourceV2(paymentContract);
	// validateAndBuildItem fetches the contract UTxO via the provider's
	// fetchUTxOs; the HydraProvider implements it. Cast is safe — only
	// fetchUTxOs is exercised here.
	const validated = await validateAndBuildItem(
		request,
		hydraProvider as unknown as BlockfrostProvider,
		network,
		smartContractAddress,
		// L2: anchor the validity window to the head's clock (env devnet override
		// or live head Tick/SyncedStatusReport time).
		resolveHydraL2WindowOptions(hydraProvider),
	);

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
		const unsignedTx = await generateMasumiSmartContractWithdrawTransactionAutomaticFees(
			'CollectCompleted',
			hydraV2Provider,
			network,
			script,
			address,
			validated.smartContractUtxo,
			collateralUtxo,
			limitedUtxos,
			{
				collectAssets: validated.collectAssets,
				collectionAddress: validated.collectionAddress,
			},
			null,
			{
				lovelace: validated.collateralReturn.lovelace,
				address: validated.collateralReturn.address,
				txHash: validated.smartContractUtxo.input.txHash,
				outputIndex: validated.smartContractUtxo.input.outputIndex,
			},
			validated.window.invalidBefore,
			validated.window.invalidAfter,
			true,
			undefined, // rpcApiKey — no chain cost-model sync on L2
			undefined, // walletSplitterLovelace — L1-only convention
			hydraV2Provider,
		);
		return await wallet.signTx(unsignedTx);
	});

	const outcome = await submitReservedL2Action({
		requestKind: 'payment',
		operation: 'collection',
		requestId: request.id,
		nextActionId: request.nextActionId,
		previousTransactionId: request.CurrentTransaction!.id,
		walletId: request.SmartContractWallet.id,
		walletLockedAt: request.SmartContractWallet.lockedAt!,
		hydraHeadId: headId,
		signedTx,
		initiatedAction: PaymentAction.WithdrawInitiated,
		retryAction: PaymentAction.WithdrawRequested,
		submitTx: async (transaction) => await hydraProvider.submitTx(transaction),
	});

	// Only a never-dispatched command rolls back now. Keep the legacy outcome
	// check for compatibility; the executor never emits it. A node rejection
	// stays ambiguous and keeps the reservation for reconciliation.
	return outcome.status !== 'definitively-rejected' && outcome.status !== 'not-dispatched';
}

/** The L2 portion of the Collection cycle, shared by the timer and the on-demand run. */
export async function runCollectionL2Pass(): Promise<void> {
	// --- Hydra L2: dedicated single-item head collection path ---
	// In-head withdraw timing differs from L1; validated on a Hydra devnet
	// (see docs/hydra-l2-devnet-findings.md).
	const l2PaymentContracts = await lockAndQueryPayments({
		paymentStatus: PaymentAction.WithdrawRequested,
		resultHash: { not: null },
		// One wallet can own only one durable L2 reservation at a time.
		maxBatchSize: 1,
		paymentSourceType: PaymentSourceType.Web3CardanoV2,
		layer: TransactionLayer.L2,
		// A request that just deferred stands aside for a moment so the rest of
		// its wallet's queue can move.
		excludeRequestIds: deferredL2RequestIds(),
		orFilters: [
			{
				onChainState: { in: [OnChainState.ResultSubmitted] },
				unlockTime: { lte: Date.now() - 1000 * 60 * 10 },
			},
			{
				onChainState: { in: [OnChainState.WithdrawAuthorized] },
			},
		],
	});
	await Promise.allSettled(
		l2PaymentContracts.map(async (paymentContract) => {
			if (paymentContract.PaymentRequests.length === 0) return;
			const network = convertNetwork(paymentContract.network);
			await Promise.allSettled(
				paymentContract.PaymentRequests.map(async (request) => {
					try {
						const progressed = await processL2Collection(request, paymentContract, network);
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
							logger.info('L2 collection deferred to next tick', { requestId: request.id, error });
						} else {
							logger.error('L2 collection failed', { requestId: request.id, error });
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
							'collection-l2-pre-reservation',
							request.SmartContractWallet!.lockedAt!,
						);
					}
				}),
			);
		}),
	);
}
