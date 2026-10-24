import { PurchasingAction } from '@/generated/prisma/client';
import type { BlockfrostProvider } from '@/services/shared';
import { SmartContractState } from '@/utils/generator/contract-generator';
import { headClockBehindCooldownMs, type HydraL2WindowOptions } from '@/utils/hydra/l2-slot-context';
import { withMeshCostModelLock } from '@/utils/mesh-cost-model-sync';
import { prisma } from '@masumi/payment-core/db';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { logger } from '@masumi/payment-core/logger';
import { deserializeDatum, resolveTxHash } from '@meshsdk/core';
import { asV2Provider } from '../../provider-cast';
import { makeHotWalletUnlocker, makePurchaseRequestFailureMarker } from '../../request-failure';
import { findMatchingPurchaseUtxo } from '../../utxo-matching';
// V2-pinned single-item builder. MUST NOT use the root V1-mesh generator (@/utils/generator/transaction-generator) — that bundles the V1 cost models and CBOR serializer, which produce a script-data-hash the ledger rejects for V2 scripts (PPViewHashesDontMatch). See docs/adr/0005.
import {
	connectPreviousAction,
	createNextPurchaseAction,
	createPendingTransaction,
	createTxWindow,
	loadHotWalletSession,
} from '@/services/shared';
import { decodeV2ContractDatum } from '@/utils/converter/string-datum-convert';
import { getPaymentScriptFromPaymentSourceV2 } from '@masumi/payment-source-v2';
import { WALLET_SPLITTER_LOVELACE, pickBatchCollateral } from '../../../builders/batch-helpers';
import { generateMasumiSmartContractWithdrawTransactionAutomaticFees } from '../../../builders/single-interaction';
import { LOOKUP_DEFERRED_PREFIX } from '../../lookup-defer';
import { fetchUTxOsWithDeferOnEmpty } from '../../utxo-fetch-helpers';
import { ensureCollateralReady } from '../../wallet-collateral/ensure-collateral-ready';

import type {
	PaymentSourceWithPurchaseRelations,
	PurchaseRequestWithRelations,
	ValidatedCollectRefundItem,
} from './service';

export const markRequestFailed = makePurchaseRequestFailureMarker({
	logMessage: 'Error collecting V2 refund',
	errorNotePrefix: 'Collecting refund failed: ',
});

export const unlockHotWallet = makeHotWalletUnlocker('collect-refund');

export async function validateAndBuildItem(
	request: PurchaseRequestWithRelations,
	blockchainProvider: BlockfrostProvider,
	network: 'mainnet' | 'preprod',
	smartContractAddress: string,
	walletAddress: string,
	// L2 only: validity-window overrides anchoring to the head's clock (devnet
	// env slot config, or the live head Tick/SyncedStatusReport time on a
	// same-network head). undefined (L1) → default network config + Date.now().
	l2WindowOptions?: HydraL2WindowOptions,
): Promise<ValidatedCollectRefundItem> {
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
	const utxo = findMatchingPurchaseUtxo(utxoByHash, txHash, request, network, smartContractAddress);
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

	// Aiken contract checks the buyer refund output against the on-chain datum's
	// `buyer_return_address`. Trust the decoded datum over the DB row to stay in
	// lockstep with what the validator will accept.
	const buyerRefundAddress: string =
		decodedContract.buyerReturnAddress ??
		request.buyerReturnAddress ??
		request.SmartContractWallet.collectionAddress ??
		walletAddress;

	// Aiken `WithdrawRefund` requires `must_start_after(validity_range,
	// submit_result_time)` for the timed path (state in FundsLocked |
	// RefundRequested). When state == RefundAuthorized the seller's signature
	// short-circuits the timed gate and no lower bound is needed. We push the
	// deadline into the `constrainBeforeMs` floor so `invalidBefore` is
	// forced past submit_result_time (the contract's lower-bound check) —
	// NOT into `constrainAfterMs`, which would lower the upper bound and
	// produce an invalid window when resultTime is already in the past
	// (steady-state given the `resultTime <= now - 10min` query filter).
	const l2SlotOverrides = l2WindowOptions ?? {};
	if (decodedContract.state !== SmartContractState.RefundAuthorized) {
		const headBehindMs = headClockBehindCooldownMs(l2SlotOverrides, decodedContract.resultTime);
		if (headBehindMs > 0) {
			throw new Error(
				`${LOOKUP_DEFERRED_PREFIX} head clock is ${Math.ceil(headBehindMs / 1000)}s behind the submit-result deadline; retry next tick`,
			);
		}
	}
	const { invalidBefore, invalidAfter } = createTxWindow(
		network,
		decodedContract.state === SmartContractState.RefundAuthorized
			? { ...l2SlotOverrides }
			: { constrainBeforeMs: decodedContract.resultTime, ...l2SlotOverrides },
	);

	return {
		request,
		smartContractUtxo: utxo,
		decodedContract,
		collectAssets: utxo.output.amount,
		buyerRefundAddress,
		window: { invalidBefore, invalidAfter },
	};
}

export async function processSingleRefundCollection(
	request: PurchaseRequestWithRelations,
	paymentContract: PaymentSourceWithPurchaseRelations,
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
		// WithdrawRefund has no on-chain upper deadline once the contract is
		// in RefundAuthorized state, and from RefundRequested it only
		// requires `must_start_after(submit_result_time)` (no upper bound).
		// Empty wallet is purely transient. Defer until funder cron tops up.
		throw new Error(`${LOOKUP_DEFERRED_PREFIX} wallet has no UTXOs; awaiting topup, retry next tick`);
	}

	// See ensureCollateralReady module note. Throw the LOOKUP_DEFERRED
	// sentinel so the fallbackToSingleItems catch arm routes the item
	// back to the queue instead of marking it failed.
	const collateralCheck = await ensureCollateralReady({
		walletDbId: request.SmartContractWallet.id,
		walletAddress: address,
		meshWallet: wallet,
		utxos,
		blockchainProvider,
		network,
		serviceLabel: 'collect-refund',
	});
	if (collateralCheck.status !== 'ready') {
		throw new Error(
			`${LOOKUP_DEFERRED_PREFIX} wallet not collateral-ready (${collateralCheck.status}); retry next tick`,
		);
	}

	const { script, smartContractAddress } = await getPaymentScriptFromPaymentSourceV2(paymentContract);
	const validated = await validateAndBuildItem(request, blockchainProvider, network, smartContractAddress, address);

	const collateralUtxo = pickBatchCollateral(utxos, [validated.smartContractUtxo.input]);
	if (collateralUtxo == null) {
		throw new Error('Collateral UTXO not found');
	}

	const unsignedTx = await withMeshCostModelLock(
		paymentContract.PaymentSourceConfig.rpcProviderApiKey,
		async () =>
			await generateMasumiSmartContractWithdrawTransactionAutomaticFees(
				'CollectRefund',
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
					collectionAddress: validated.buyerRefundAddress,
				},
				null,
				null,
				validated.window.invalidBefore,
				validated.window.invalidAfter,
				// V2 contract requires the buyer's refund output to be tagged with own_ref
				// when buyer_return_address is Some. Tagging is also safe when None.
				true,
				paymentContract.PaymentSourceConfig.rpcProviderApiKey,
				// V2 single-item splitter — leave wallet at 3 UTxOs post-tx.
				WALLET_SPLITTER_LOVELACE,
			),
	);

	const signedTx = await wallet.signTx(unsignedTx);
	// Submit FIRST, then write DB. See submit-first rationale in
	// packages/payment-source-v2/src/services/payments/collection/service.ts.
	// Brief recap: pre-submit DB row → submit pattern strands the wallet
	// (Pending Tx row with BlocksWallet → wallet, no txHash) whenever
	// submitTx throws, leaving cleanup to wallet-timeouts minutes later.
	// Submit-first leaves NO Tx row on a pre-submit throw; the caller's
	// catch arm (markRequestFailed) clears lockedAt. Mirrors the pattern
	// already used in V2 payments/{authorize-refund,collection,submit-result}.
	const newTxHash = await wallet.submitTx(signedTx);
	// Divergence check — parity with this service's batch path. submitTx's
	// returned hash must equal the deterministic resolveTxHash(signedTx); a
	// mismatch signals a Mesh/Cardano serialization bug. We keep newTxHash (it
	// is the hash the node accepted and what tx-sync will observe), but log
	// loudly so single-item submits are investigable like the batch path.
	const intendedTxHash = resolveTxHash(signedTx);
	if (newTxHash !== intendedTxHash) {
		logger.error('V2 collect-refund single-item: node returned divergent txHash — investigate', {
			intendedTxHash,
			nodeTxHash: newTxHash,
		});
	}
	// Non-fatal: the tx is already on-chain. A projection failure must NOT
	// propagate to advancedRetry and rebuild+resubmit an already-broadcast tx.
	try {
		await walletSession.evaluateProjectedBalance(unsignedTx, utxos);
	} catch (projectionError) {
		logger.warn('V2 collect-refund single-item: post-submit balance projection failed (non-fatal)', {
			txHash: newTxHash,
			error: projectionError instanceof Error ? projectionError.message : String(projectionError),
		});
	}
	// Snapshot the wallet id before the closure — TS narrowing of
	// request.SmartContractWallet doesn't survive into the arrow function.
	const smartContractWalletId = request.SmartContractWallet.id;
	await retryOnSerializationConflict(
		() =>
			prisma.purchaseRequest.update({
				where: { id: request.id },
				data: {
					...connectPreviousAction(request.nextActionId),
					...createNextPurchaseAction(PurchasingAction.WithdrawRefundInitiated, { submittedTxHash: null }),
					...createPendingTransaction(smartContractWalletId, newTxHash),
					TransactionHistory: { connect: { id: request.CurrentTransaction!.id } },
				},
			}),
		{ label: 'v2-collect-refund-single-post-submit' },
	);

	logger.debug(`Created V2 refund-collection transaction:
              Tx ID: ${newTxHash}
              View on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${newTxHash}
              Smart Contract Address: ${smartContractAddress}
          `);
	return true;
}
