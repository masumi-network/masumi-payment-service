import { PaymentAction, Prisma } from '@/generated/prisma/client';
import type { BlockfrostProvider } from '@/services/shared';
import { DecodedV1ContractDatum } from '@/utils/converter/string-datum-convert';
import { SmartContractState } from '@/utils/generator/contract-generator';
import { headClockBehindCooldownMs, type HydraL2WindowOptions } from '@/utils/hydra/l2-slot-context';
import { withMeshCostModelLock } from '@/utils/mesh-cost-model-sync';
import { prisma } from '@masumi/payment-core/db';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { logger } from '@masumi/payment-core/logger';
import type { UTxO } from '@meshsdk/core';
import { Asset, deserializeDatum, resolveTxHash } from '@meshsdk/core';
import { advancedRetry, delayErrorResolver } from 'advanced-retry';
import { asV2Provider } from '../../provider-cast';
import { makeHotWalletUnlocker, makePaymentRequestFailureMarker } from '../../request-failure';
import { findMatchingPaymentUtxo } from '../../utxo-matching';
// V2-pinned single-item builder. MUST NOT use the root V1-mesh generator
// (@/utils/generator/transaction-generator) — that bundles the V1 cost models
// and CBOR serializer, which produce a script-data-hash the ledger rejects for
// V2 scripts (PPViewHashesDontMatch). See docs/adr/0005.
import {
	connectPreviousAction,
	createNextPaymentAction,
	createPendingTransaction,
	createTxWindow,
	loadHotWalletSession,
} from '@/services/shared';
import { decodeV2ContractDatum } from '@/utils/converter/string-datum-convert';
import { getPaymentScriptFromPaymentSourceV2 } from '@masumi/payment-source-v2';
import { WALLET_SPLITTER_LOVELACE, pickBatchCollateral, type TxWindowBounds } from '../../../builders/batch-helpers';
import { generateMasumiSmartContractWithdrawTransactionAutomaticFees } from '../../../builders/single-interaction';
import { LOOKUP_DEFERRED_PREFIX, isLookupDeferred } from '../../lookup-defer';
import { fetchUTxOsWithDeferOnEmpty } from '../../utxo-fetch-helpers';
import { ensureCollateralReady } from '../../wallet-collateral/ensure-collateral-ready';

export type PaymentSourceWithRelations = Prisma.PaymentSourceGetPayload<{
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

export type PaymentRequestWithRelations = PaymentSourceWithRelations['PaymentRequests'][number];

export type ValidatedCollectionItem = {
	request: PaymentRequestWithRelations;
	smartContractUtxo: UTxO;
	decodedContract: DecodedV1ContractDatum;
	collectAssets: Asset[];
	collectionAddress: string;
	collateralReturn: { lovelace: bigint; address: string };
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

export const markRequestFailed = makePaymentRequestFailureMarker({
	logMessage: 'Error collecting V2 payments',
	errorNotePrefix: 'Collecting payments failed: ',
});

export const unlockHotWallet = makeHotWalletUnlocker('collection');

export async function validateAndBuildItem(
	request: PaymentRequestWithRelations,
	blockchainProvider: BlockfrostProvider,
	network: 'mainnet' | 'preprod',
	smartContractAddress: string,
	// L2 only: validity-window overrides anchoring to the head's clock (devnet
	// env slot config, or the live head Tick/SyncedStatusReport time on a
	// same-network head). Without this the head's lagging ledger clock rejects
	// the window with OutsideValidityIntervalUTxO. undefined → L1 defaults.
	l2WindowOptions?: HydraL2WindowOptions,
): Promise<ValidatedCollectionItem> {
	if (request.payByTime == null) {
		throw new Error('Pay by time is null, this is deprecated');
	}
	if (request.collateralReturnLovelace == null) {
		throw new Error('Collateral return lovelace is null, this is deprecated');
	}
	if (request.SmartContractWallet == null) {
		throw new Error('Smart contract wallet not found');
	}
	const txHash = request.CurrentTransaction?.txHash;
	if (txHash == null) {
		throw new Error('Transaction hash not found');
	}
	const utxoByHash = await fetchUTxOsWithDeferOnEmpty(blockchainProvider, txHash);
	const utxo = findMatchingPaymentUtxo(utxoByHash, txHash, request, network, smartContractAddress);
	if (!utxo) {
		throw new Error(`${LOOKUP_DEFERRED_PREFIX} UTXO not found`);
	}
	const utxoDatum = utxo.output.plutusData;
	if (!utxoDatum) {
		throw new Error(`${LOOKUP_DEFERRED_PREFIX} No datum found in UTXO`);
	}
	const decodedDatum: unknown = deserializeDatum(utxoDatum);
	const decodedContract = decodeV2ContractDatum(decodedDatum, network, smartContractAddress);
	if (decodedContract == null) {
		throw new Error(`${LOOKUP_DEFERRED_PREFIX} Invalid datum`);
	}

	if (BigInt(decodedContract.collateralReturnLovelace) !== request.collateralReturnLovelace) {
		logger.error(
			'Collateral return lovelace does not match collateral return lovelace in db. This likely is a spoofing attempt.',
			{
				purchaseRequestId: request.id,
				collateralReturnLovelace: decodedContract.collateralReturnLovelace,
			},
		);
		throw new Error(
			'Collateral return lovelace does not match collateral return lovelace in db. This likely is a spoofing attempt.',
		);
	}

	const buyerAddress = request.BuyerWallet?.walletAddress;
	if (buyerAddress == null) {
		throw new Error('Buyer wallet not found');
	}
	if (buyerAddress !== decodedContract.buyerAddress) {
		throw new Error('Buyer wallet does not match buyer in contract');
	}

	// V2 has zero protocol fees: every input asset moves to the collection address.
	const remainingAssets: { [key: string]: Asset } = {};
	for (const assetValue of utxo.output.amount) {
		remainingAssets[assetValue.unit] = {
			unit: assetValue.unit,
			quantity: assetValue.quantity,
		};
	}

	// The escrow UTxO holds RequestedFunds + collateralReturnLovelace. The
	// collateral is returned to the buyer in its own output (collateralReturn
	// below), so it MUST be subtracted from the seller's payout here. The Aiken
	// validator requires the seller output to be at least
	// `value_minus_lovelace(input.value, collateral_return_lovelace)` and the
	// buyer output at least `collateral_return_lovelace` — both `>=`, so paying
	// the seller the FULL input and ALSO returning collateral passes on-chain
	// while silently funding the extra collateral (and fees) from the seller hot
	// wallet, draining it on every collection.
	const collateralReturnLovelace = request.collateralReturnLovelace;
	if (collateralReturnLovelace > 0n) {
		const lovelaceKey = Object.keys(remainingAssets).find((unit) => unit === '' || unit.toLowerCase() === 'lovelace');
		if (lovelaceKey == null) {
			throw new Error('Collateral return requested but escrow UTxO has no lovelace to deduct it from');
		}
		const sellerLovelace = BigInt(remainingAssets[lovelaceKey].quantity) - collateralReturnLovelace;
		if (sellerLovelace < 0n) {
			throw new Error('Collateral return exceeds locked lovelace');
		}
		remainingAssets[lovelaceKey] = {
			unit: remainingAssets[lovelaceKey].unit,
			quantity: sellerLovelace.toString(),
		};
	}

	// Aiken contract validates the seller payout output against the on-chain
	// datum's `seller_return_address`. Trust the decoded datum first so we stay
	// in lockstep with what the validator will accept.
	let collectionAddress: string | null =
		decodedContract.sellerReturnAddress ?? request.sellerReturnAddress ?? request.SmartContractWallet.collectionAddress;
	if (collectionAddress == null || collectionAddress === '') {
		collectionAddress = request.SmartContractWallet.walletAddress;
	}

	// Aiken `Withdraw` requires `must_start_after(validity_range, unlock_time)`
	// for the timed path (state == ResultSubmitted). When state ==
	// WithdrawAuthorized the buyer's signature short-circuits the timed gate
	// and no lower bound is needed. We push the deadline into the
	// `constrainBeforeMs` floor so `invalidBefore` is forced past unlock_time
	// (the contract's lower-bound check) — NOT into `constrainAfterMs`, which
	// would lower the upper bound and produce an invalid window when the
	// deadline is already in the past (which is the steady-state case given
	// the `unlockTime <= now - 10min` query filter).
	const lowerBoundMs =
		decodedContract.state === SmartContractState.WithdrawAuthorized
			? decodedContract.sellerCooldownTime
			: decodedContract.sellerCooldownTime > decodedContract.unlockTime
				? decodedContract.sellerCooldownTime
				: decodedContract.unlockTime;
	const headBehindMs = headClockBehindCooldownMs(l2WindowOptions ?? {}, lowerBoundMs);
	if (headBehindMs > 0) {
		throw new Error(
			`${LOOKUP_DEFERRED_PREFIX} head clock is ${Math.ceil(headBehindMs / 1000)}s behind the unlock/cooldown bound; retry next tick`,
		);
	}
	const { invalidBefore, invalidAfter } = createTxWindow(network, {
		constrainBeforeMs: lowerBoundMs,
		...(l2WindowOptions ?? {}),
	});

	return {
		request,
		smartContractUtxo: utxo,
		decodedContract,
		collectAssets: Object.values(remainingAssets),
		collectionAddress,
		collateralReturn: {
			lovelace: request.collateralReturnLovelace,
			// Aiken `Withdraw` checks the collateral return output via
			// `outputs_with_reference_tag(..., buyer, buyer_return_address)`.
			// When buyer_return_address is Some the validator demands the
			// collateral land at that address, NOT at the buyer's vkey address.
			address: decodedContract.buyerReturnAddress ?? buyerAddress,
		},
		window: { invalidBefore, invalidAfter },
	};
}

async function processSinglePaymentCollection(
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
	if (request.SmartContractWallet == null) throw new Error('Smart contract wallet not found');

	const walletSession = await loadHotWalletSession({
		network: paymentContract.network,
		rpcProviderApiKey: paymentContract.PaymentSourceConfig.rpcProviderApiKey,
		encryptedMnemonic: request.SmartContractWallet.Secret.encryptedMnemonic,
		hotWalletId: request.SmartContractWallet.id,
	});
	const { wallet, utxos, address } = walletSession;

	if (utxos.length === 0) {
		// Collection (Withdraw) has no on-chain upper deadline once unlockTime
		// passes — seller can withdraw indefinitely. Empty wallet is purely
		// transient until the funder cron tops up. Defer so the request
		// stays queued instead of parking in WaitingForManualAction.
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
		walletDbId: request.SmartContractWallet.id,
		walletAddress: address,
		meshWallet: wallet,
		utxos,
		blockchainProvider,
		network,
		serviceLabel: 'collection-single',
	});
	if (collateralCheck.status !== 'ready') {
		throw new Error(
			`${LOOKUP_DEFERRED_PREFIX} wallet not collateral-ready (${collateralCheck.status}); retry next tick`,
		);
	}

	const { script, smartContractAddress } = await getPaymentScriptFromPaymentSourceV2(paymentContract);
	const validated = await validateAndBuildItem(request, blockchainProvider, network, smartContractAddress);

	const collateralUtxo = pickBatchCollateral(utxos, [validated.smartContractUtxo.input]);
	if (collateralUtxo == null) {
		throw new Error('Collateral UTXO not found');
	}

	const unsignedTx = await withMeshCostModelLock(
		paymentContract.PaymentSourceConfig.rpcProviderApiKey,
		async () =>
			await generateMasumiSmartContractWithdrawTransactionAutomaticFees(
				'CollectCompleted',
				// V2-pinned builder expects the V2 mesh provider type; cast the shared
				// (V1-resolved) instance — identical runtime object. See provider-cast.ts.
				asV2Provider(blockchainProvider),
				network,
				script,
				address,
				validated.smartContractUtxo,
				collateralUtxo,
				utxos,
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
				// V2 contract requires the seller's main output to be tagged with own_ref
				// when seller_return_address is Some. Tagging is also safe when None.
				true,
				paymentContract.PaymentSourceConfig.rpcProviderApiKey,
				// V2 single-item splitter — leave wallet at 3 UTxOs post-tx.
				WALLET_SPLITTER_LOVELACE,
			),
	);

	const signedTx = await wallet.signTx(unsignedTx);
	// Submit FIRST, then write DB. Previous order (DB row → submitTx) left an
	// orphan Pending Transaction row holding BlocksWallet → wallet whenever
	// submitTx threw: the wallet stayed locked via HotWallet.pendingTransactionId
	// until wallet-timeouts swept it minutes later. With submit-first, a
	// pre-submit throw leaves NO Tx row to clean up; the caller's catch arm
	// (markRequestFailed) is responsible for clearing lockedAt. A post-submit
	// throw leaves the Tx row in place (it points at a real on-chain tx) per
	// the user's "do NOT revert after successful submit" constraint.
	//
	// Create a FRESH Transaction row per lifecycle phase rather than mutating
	// the upstream tx in-place. Recycling the prior Transaction row via
	// `CurrentTransaction.update({ txHash: null, status: Pending })` loses the
	// terminal status of the previous phase (e.g. the original submit-result
	// tx is Confirmed; flipping it back to Pending breaks tx-sync's
	// idempotency guards) and entangles two distinct on-chain txs in one DB
	// row. createPendingTransaction makes a new row with BlocksWallet → this
	// wallet, and the prior Transaction id is pushed onto TransactionHistory
	// so the audit trail still shows the submit-result tx.
	const newTxHash = await wallet.submitTx(signedTx);
	// Divergence check — parity with this service's batch path. submitTx's
	// returned hash must equal the deterministic resolveTxHash(signedTx); a
	// mismatch signals a Mesh/Cardano serialization bug. We keep newTxHash (it
	// is the hash the node accepted and what tx-sync will observe), but log
	// loudly so single-item submits are investigable like the batch path.
	const intendedTxHash = resolveTxHash(signedTx);
	if (newTxHash !== intendedTxHash) {
		logger.error('V2 collection single-item: node returned divergent txHash — investigate', {
			intendedTxHash,
			nodeTxHash: newTxHash,
		});
	}
	// Non-fatal: the tx is already on-chain. A balance-projection failure (e.g. a
	// transient DB error in the low-balance evaluation) must NOT propagate to the
	// outer advancedRetry and trigger a rebuild+resubmit of an already-broadcast
	// tx. Parity with the batch path, which wraps the identical call "(non-fatal)".
	try {
		await walletSession.evaluateProjectedBalance(unsignedTx, utxos);
	} catch (projectionError) {
		logger.warn('V2 collection single-item: post-submit balance projection failed (non-fatal)', {
			paymentRequestId: request.id,
			error: projectionError instanceof Error ? projectionError.message : String(projectionError),
		});
	}
	// Post-submit DB update: wrap in retryOnSerializationConflict so a transient
	// serialization conflict (concurrent tx-sync writer that just saw this tx
	// land, recovery cron, manual API touch) doesn't bubble up to the outer
	// `advancedRetry` and cause it to re-invoke processSinglePaymentCollection
	// — which would build & submit a SECOND on-chain tx for the same request
	// (input UTxO already consumed → phase-2 fail + ex-units burn). Bare
	// update was the post-submit single-item analog of #2 funding double-lock.
	// Snapshot the wallet id before the closure — TS narrowing of
	// request.SmartContractWallet doesn't survive into the arrow function.
	const smartContractWalletId = request.SmartContractWallet.id;
	await retryOnSerializationConflict(
		() =>
			prisma.paymentRequest.update({
				where: { id: request.id },
				data: {
					...connectPreviousAction(request.nextActionId),
					...createNextPaymentAction(PaymentAction.WithdrawInitiated),
					...createPendingTransaction(smartContractWalletId, newTxHash),
					TransactionHistory: { connect: { id: request.CurrentTransaction!.id } },
				},
			}),
		{ label: 'v2-collection-single-post-submit' },
	);

	logger.debug(`Created V2 withdrawal transaction:
        Tx ID: ${newTxHash}
        View on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${newTxHash}
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
				const ok = await processSinglePaymentCollection(request, paymentContract, blockchainProvider, network);
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
