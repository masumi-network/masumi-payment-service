import { UTxO } from '@meshsdk/core';
import type { BlockfrostProvider } from '@/services/shared';
import { createTxWindow } from '@/services/shared';
import { createDatumFromDecodedContractV2 } from '@masumi/payment-source-v2';
import { convertNetwork } from '@/utils/converter/network-convert';
import { DecodedV1ContractDatum, newCooldownTime } from '@/utils/converter/string-datum-convert';
import { findMatchingPaymentUtxoWithContract } from '../../utxo-matching';
import { type TxWindowBounds } from '../../../builders/batch-helpers';
import { LOOKUP_DEFERRED_PREFIX } from '../../lookup-defer';
import { fetchUTxOsWithDeferOnEmpty } from '../../utxo-fetch-helpers';
import { determineNewContractState } from './contract-state';
import type { PaymentRequestWithRelations, PaymentSourceWithRelations } from './types';
import { resolveSubmitResultConstrainAfterMs } from './window';

export type ValidatedSubmitItem = {
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

/**
 * Per-request validation. Locates the matching script UTxO, decodes the on-chain
 * datum, builds the new continuation datum, and computes the per-item tx-window
 * bounds. Throws on validation failure — caller maps the throw to a per-request
 * failure update.
 */
export async function validateAndBuildItem(
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

	return {
		request,
		smartContractUtxo: utxo,
		decodedContract,
		newInlineDatum: datum.value,
		window: { invalidBefore, invalidAfter },
	};
}
