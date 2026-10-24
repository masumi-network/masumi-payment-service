import { PurchasingAction } from '@/generated/prisma/client';
import type { BlockfrostProvider } from '@/services/shared';
import { DecodedV1ContractDatum, newCooldownTime } from '@/utils/converter/string-datum-convert';
import { SmartContractState } from '@/utils/generator/contract-generator';
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
import { createDatumFromDecodedContractV2, getPaymentScriptFromPaymentSourceV2 } from '@masumi/payment-source-v2';
import { pickBatchCollateral, WALLET_SPLITTER_LOVELACE } from '../../../builders/batch-helpers';
import { generateMasumiSmartContractInteractionTransactionAutomaticFees } from '../../../builders/single-interaction';
import { LOOKUP_DEFERRED_PREFIX } from '../../lookup-defer';
import { fetchUTxOsWithDeferOnEmpty } from '../../utxo-fetch-helpers';
import { ensureCollateralReady } from '../../wallet-collateral/ensure-collateral-ready';

import type {
	PaymentSourceWithPurchaseRelations,
	PurchaseRequestWithRelations,
	ValidatedRequestRefundItem,
} from './service';

export function validatePurchaseRequestFields(request: PurchaseRequestWithRelations): void {
	if (request.payByTime == null) {
		throw new Error('Pay by time is null, this is deprecated');
	}
	if (request.collateralReturnLovelace == null) {
		throw new Error('Collateral return lovelace is null, this is deprecated');
	}
	if (request.CurrentTransaction?.txHash == null) {
		throw new Error('Transaction hash not found');
	}
	if (request.SmartContractWallet == null) {
		throw new Error('Purchasing wallet not found');
	}
}

export const markRequestFailed = makePurchaseRequestFailureMarker({
	logMessage: 'Error requesting V2 refund',
	errorNotePrefix: 'Requesting refund failed: ',
});

export const unlockHotWallet = makeHotWalletUnlocker('request-refund');

export function createRequestRefundDatum(params: {
	decodedContract: DecodedV1ContractDatum;
	blockchainIdentifier: string;
	cooldownTime: bigint;
	windowUpperMs: number;
}) {
	// Aiken SetRefundRequested requires every field of the continuation datum
	// (including buyer/seller addresses AND return addresses) to equal the
	// decoded input's values. Mirror chain state to avoid DB drift failing the
	// validator. Other rewrite-able fields stay nulled via createDatumFromDecodedContractV2.
	return createDatumFromDecodedContractV2({
		decodedContract: params.decodedContract,
		buyerAddress: params.decodedContract.buyerAddress,
		buyerReturnAddress: params.decodedContract.buyerReturnAddress,
		sellerAddress: params.decodedContract.sellerAddress,
		sellerReturnAddress: params.decodedContract.sellerReturnAddress,
		blockchainIdentifier: params.blockchainIdentifier,
		resultHash: params.decodedContract.resultHash,
		newCooldownTimeSeller: BigInt(0),
		newCooldownTimeBuyer: newCooldownTime(params.cooldownTime, params.windowUpperMs),
		state:
			params.decodedContract.resultHash == null || params.decodedContract.resultHash === ''
				? SmartContractState.RefundRequested
				: SmartContractState.Disputed,
	});
}

export async function validateAndBuildItem(
	request: PurchaseRequestWithRelations,
	paymentContract: PaymentSourceWithPurchaseRelations,
	blockchainProvider: BlockfrostProvider,
	network: 'mainnet' | 'preprod',
	smartContractAddress: string,
): Promise<ValidatedRequestRefundItem> {
	validatePurchaseRequestFields(request);
	const txHash = request.CurrentTransaction!.txHash!;
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
	const { invalidBefore, invalidAfter, invalidAfterMs } = createTxWindow(network, {
		constrainAfterMs: decodedContract.unlockTime,
		constrainBeforeMs: decodedContract.buyerCooldownTime,
	});
	const datum = createRequestRefundDatum({
		decodedContract,
		blockchainIdentifier: request.blockchainIdentifier,
		cooldownTime: BigInt(paymentContract.cooldownTime),
		windowUpperMs: invalidAfterMs,
	});
	return {
		request,
		smartContractUtxo: utxo,
		decodedContract,
		newInlineDatum: datum.value,
		window: { invalidBefore, invalidAfter },
	};
}

export async function processSinglePurchaseRequest(
	request: PurchaseRequestWithRelations,
	paymentContract: PaymentSourceWithPurchaseRelations,
	blockchainProvider: BlockfrostProvider,
	network: 'mainnet' | 'preprod',
): Promise<boolean> {
	validatePurchaseRequestFields(request);
	const purchasingWallet = request.SmartContractWallet!;
	const walletSession = await loadHotWalletSession({
		network: paymentContract.network,
		rpcProviderApiKey: paymentContract.PaymentSourceConfig.rpcProviderApiKey,
		encryptedMnemonic: purchasingWallet.Secret.encryptedMnemonic,
		hotWalletId: purchasingWallet.id,
	});
	const { wallet, utxos, address } = walletSession;
	if (utxos.length === 0) {
		// Wallet empty — check if the buyer's on-chain refund-request
		// deadline has passed. Aiken `SetRefundRequested` requires
		// `must_end_before(validity_range, unlock_time)`, so past this
		// point the buyer cannot raise a refund anymore. Topup won't help;
		// park for manual intervention.
		const requestDeadlineMs = Number(request.unlockTime);
		// Require a positive finite timestamp; treat 0/negative as a
		// data-integrity bug (deadline never set) rather than "passed".
		// Without the `> 0` guard, `Date.now() > 0` is always true and a
		// row with an uninitialised deadline silently falls into manual
		// intervention.
		if (Number.isFinite(requestDeadlineMs) && requestDeadlineMs > 0 && Date.now() > requestDeadlineMs) {
			throw new Error(
				'Wallet empty and on-chain unlockTime deadline passed for refund request; manual intervention required',
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
		walletDbId: purchasingWallet.id,
		walletAddress: address,
		meshWallet: wallet,
		utxos,
		blockchainProvider,
		network,
		serviceLabel: 'request-refund',
	});
	if (collateralCheck.status !== 'ready') {
		throw new Error(
			`${LOOKUP_DEFERRED_PREFIX} wallet not collateral-ready (${collateralCheck.status}); retry next tick`,
		);
	}

	const { script, smartContractAddress } = await getPaymentScriptFromPaymentSourceV2(paymentContract);
	const txHash = request.CurrentTransaction!.txHash!;
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
	const { invalidBefore, invalidAfter, invalidAfterMs } = createTxWindow(network, {
		constrainAfterMs: decodedContract.unlockTime,
		constrainBeforeMs: decodedContract.buyerCooldownTime,
	});
	const datum = createRequestRefundDatum({
		decodedContract,
		blockchainIdentifier: request.blockchainIdentifier,
		cooldownTime: BigInt(paymentContract.cooldownTime),
		windowUpperMs: invalidAfterMs,
	});

	const collateralUtxo = pickBatchCollateral(utxos, [utxo.input]);
	if (collateralUtxo == null) {
		throw new Error('Collateral UTXO not found');
	}

	const unsignedTx = await withMeshCostModelLock(
		paymentContract.PaymentSourceConfig.rpcProviderApiKey,
		async () =>
			await generateMasumiSmartContractInteractionTransactionAutomaticFees(
				'RequestRefund',
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
	// Submit FIRST, then write DB. See submit-first rationale in
	// packages/payment-source-v2/src/services/payments/collection/service.ts.
	// Brief recap: pre-submit DB row → submit pattern strands the wallet
	// (Pending Tx row with BlocksWallet → wallet, no txHash) whenever
	// submitTx throws, leaving cleanup to wallet-timeouts minutes later.
	// Mirrors the pattern already used in V2 payments/{authorize-refund,
	// collection,submit-result}.
	const newTxHash = await wallet.submitTx(signedTx);
	// Divergence check — parity with this service's batch path. submitTx's
	// returned hash must equal the deterministic resolveTxHash(signedTx); a
	// mismatch signals a Mesh/Cardano serialization bug. We keep newTxHash (it
	// is the hash the node accepted and what tx-sync will observe), but log
	// loudly so single-item submits are investigable like the batch path.
	const intendedTxHash = resolveTxHash(signedTx);
	if (newTxHash !== intendedTxHash) {
		logger.error('V2 request-refund single-item: node returned divergent txHash — investigate', {
			intendedTxHash,
			nodeTxHash: newTxHash,
		});
	}
	// Non-fatal: the tx is already on-chain. A projection failure must NOT
	// propagate to advancedRetry and rebuild+resubmit an already-broadcast tx.
	try {
		await walletSession.evaluateProjectedBalance(unsignedTx, utxos);
	} catch (projectionError) {
		logger.warn('V2 request-refund single-item: post-submit balance projection failed (non-fatal)', {
			txHash: newTxHash,
			error: projectionError instanceof Error ? projectionError.message : String(projectionError),
		});
	}
	await retryOnSerializationConflict(
		() =>
			prisma.purchaseRequest.update({
				where: { id: request.id },
				data: {
					...connectPreviousAction(request.nextActionId),
					...createNextPurchaseAction(PurchasingAction.SetRefundRequestedInitiated),
					...createPendingTransaction(purchasingWallet.id, newTxHash),
					TransactionHistory: { connect: { id: request.CurrentTransaction!.id } },
				},
			}),
		{ label: 'v2-request-refund-single-post-submit' },
	);

	logger.debug(`Created refund request transaction:
              Tx ID: ${newTxHash}
              View (after a bit) on https://${
								network === 'preprod' ? 'preprod.' : ''
							}cardanoscan.io/transaction/${newTxHash}
              Smart Contract Address: ${smartContractAddress}
          `);
	return true;
}
