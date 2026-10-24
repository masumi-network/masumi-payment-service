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
	ValidatedAuthorizeWithdrawalItem,
} from './service';

export function validatePurchaseRequestFields(request: {
	payByTime: bigint | null;
	collateralReturnLovelace: bigint | null;
	CurrentTransaction: { txHash: string | null } | null;
	SmartContractWallet: object | null;
}): void {
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
	logMessage: 'Error authorizing V2 withdrawal',
	errorNotePrefix: 'Authorizing V2 withdrawal failed: ',
});

export const unlockHotWallet = makeHotWalletUnlocker('authorize-withdrawal');

export function createAuthorizeWithdrawalDatum(params: {
	decodedContract: DecodedV1ContractDatum;
	buyerAddress: string;
	sellerAddress: string;
	blockchainIdentifier: string;
	cooldownTime: bigint;
	windowUpperMs: number;
}) {
	return createDatumFromDecodedContractV2({
		decodedContract: params.decodedContract,
		buyerAddress: params.buyerAddress,
		sellerAddress: params.sellerAddress,
		blockchainIdentifier: params.blockchainIdentifier,
		resultHash: params.decodedContract.resultHash,
		newCooldownTimeSeller: BigInt(0),
		newCooldownTimeBuyer: newCooldownTime(params.cooldownTime, params.windowUpperMs),
		state: SmartContractState.WithdrawAuthorized,
	});
}

export async function validateAndBuildItem(
	request: PurchaseRequestWithRelations,
	paymentContract: PaymentSourceWithPurchaseRelations,
	blockchainProvider: BlockfrostProvider,
	network: 'mainnet' | 'preprod',
	smartContractAddress: string,
): Promise<ValidatedAuthorizeWithdrawalItem> {
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
	// Aiken `AuthorizeWithdrawal` strictly compares new_datum.buyer/seller
	// against the input's buyer/seller. Trust the decoded chain values so
	// any DB drift cannot brick the tx with a silent field mismatch.
	// Aiken `AuthorizeWithdrawal` requires `must_start_after(validity_range,
	// buyer_cooldown_time)`. The default tx-window's `invalidBefore` is
	// `now - 2.5min`, which is BEFORE any buyer cooldown set seconds ago.
	// Bind the lower bound to the on-chain cooldown so the validator's
	// start-after check is always satisfied.
	const { invalidBefore, invalidAfter, invalidAfterMs } = createTxWindow(network, {
		constrainBeforeMs: decodedContract.buyerCooldownTime,
	});
	const datum = createAuthorizeWithdrawalDatum({
		decodedContract,
		buyerAddress: decodedContract.buyerAddress,
		sellerAddress: decodedContract.sellerAddress,
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
		// AuthorizeWithdrawal has no on-chain time gate (Aiken requires
		// state == ResultSubmitted with no must_end_before), so an empty
		// wallet is purely transient until the funder cron tops up. Defer
		// so the request stays queued instead of parking in
		// WaitingForManualAction.
		throw new Error(`${LOOKUP_DEFERRED_PREFIX} wallet has no UTXOs; awaiting topup, retry next tick`);
	}

	// See ensureCollateralReady module note. Throw the LOOKUP_DEFERRED
	// sentinel so the fallbackToSingleItems catch arm routes the item back
	// to the queue instead of marking it failed. Mirrors the gate in
	// collect-refund/submit-result/authorize-refund/request-refund/collection
	// single-item paths.
	const collateralCheck = await ensureCollateralReady({
		walletDbId: purchasingWallet.id,
		walletAddress: address,
		meshWallet: wallet,
		utxos,
		blockchainProvider,
		network,
		serviceLabel: 'authorize-withdrawal',
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
		constrainBeforeMs: decodedContract.buyerCooldownTime,
	});
	const datum = createAuthorizeWithdrawalDatum({
		decodedContract,
		buyerAddress: decodedContract.buyerAddress,
		sellerAddress: decodedContract.sellerAddress,
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
				'AuthorizeWithdrawal',
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
	// submitTx threw: the wallet stayed locked via HotWallet.pendingTransactionId
	// until wallet-timeouts swept it minutes later. With submit-first, a
	// pre-submit throw leaves NO Tx row to clean up; the caller's catch arm
	// (markRequestFailed / advancedRetry) is responsible for clearing
	// lockedAt. A post-submit throw leaves the new Tx row in place (it points
	// at a real on-chain tx) per the user's "do NOT revert after successful
	// submit" constraint. Mirrors the submit-first pattern used in
	// packages/payment-source-v2/src/services/payments/collection/service.ts
	// and payments/{authorize-refund,submit-result}.
	const newTxHash = await wallet.submitTx(signedTx);
	// Divergence check — parity with this service's batch path. submitTx's
	// returned hash must equal the deterministic resolveTxHash(signedTx); a
	// mismatch signals a Mesh/Cardano serialization bug. We keep newTxHash (it
	// is the hash the node accepted and what tx-sync will observe), but log
	// loudly so single-item submits are investigable like the batch path.
	const intendedTxHash = resolveTxHash(signedTx);
	if (newTxHash !== intendedTxHash) {
		logger.error('V2 authorize-withdrawal single-item: node returned divergent txHash — investigate', {
			intendedTxHash,
			nodeTxHash: newTxHash,
		});
	}
	// Non-fatal: the tx is already on-chain. A projection failure must NOT
	// propagate to advancedRetry and rebuild+resubmit an already-broadcast tx.
	try {
		await walletSession.evaluateProjectedBalance(unsignedTx, utxos);
	} catch (projectionError) {
		logger.warn('V2 authorize-withdrawal single-item: post-submit balance projection failed (non-fatal)', {
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
					...createNextPurchaseAction(PurchasingAction.AuthorizeWithdrawalInitiated),
					...createPendingTransaction(purchasingWallet.id, newTxHash),
					TransactionHistory: { connect: { id: request.CurrentTransaction!.id } },
				},
			}),
		{ label: 'v2-authorize-withdrawal-single-post-submit' },
	);

	logger.debug(`Created V2 authorize-withdrawal transaction:
              Tx ID: ${newTxHash}
              View on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${newTxHash}
              Smart Contract Address: ${smartContractAddress}
          `);
	return true;
}
