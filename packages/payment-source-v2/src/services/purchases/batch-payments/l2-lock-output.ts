import { getOutputMinLovelace } from '@meshsdk/core';
import { createDatumFromBlockchainIdentifierV2 } from '@masumi/payment-source-v2';
import { SmartContractState } from '@masumi/payment-core/smart-contract-state';
import { calculateMinUtxo, DUMMY_RESULT_HASH } from '@/utils/min-utxo';
import { buildL2LockDatumParams, planL2LockValue } from './l2-lock-helpers';
import type { L2PurchaseRequest } from './l2-lock-submit';

/**
 * The escrow output of an in-head funds-lock: its FundsLocked datum and the value
 * that funds it, pre-funded for the larger ResultSubmitted continuation. Shared by
 * plain and guarded locks, which differ only in where the value comes from.
 */
export function planL2EscrowLock(params: {
	request: L2PurchaseRequest;
	smartContractAddress: string;
	buyerAddress: string;
	buyerReturnAddress: string | null;
	coinsPerUtxoSize: number;
}) {
	const { request, smartContractAddress, buyerAddress, buyerReturnAddress, coinsPerUtxoSize } = params;
	if (request.payByTime == null) {
		throw new Error('Pay by time is null, this is deprecated');
	}
	if (request.inputHash == null) {
		throw new Error('Purchase request has no input hash');
	}
	const sellerAddress = request.SellerWallet.walletAddress;
	const lockRequestFields = {
		buyerReturnAddress: request.buyerReturnAddress,
		sellerReturnAddress: request.sellerReturnAddress,
		blockchainIdentifier: request.blockchainIdentifier,
		inputHash: request.inputHash,
		payByTime: request.payByTime,
		submitResultTime: request.submitResultTime,
		unlockTime: request.unlockTime,
		externalDisputeUnlockTime: request.externalDisputeUnlockTime,
	};
	if (!Number.isSafeInteger(coinsPerUtxoSize) || coinsPerUtxoSize <= 0) {
		throw new Error('Hydra protocol parameters contain an invalid coinsPerUtxoSize');
	}
	const nativeTokenCount = request.PaidFunds.filter(
		(fund) => fund.unit !== '' && fund.unit.toLowerCase() !== 'lovelace',
	).length;
	const paidAssets = new Map<string, bigint>();
	for (const fund of request.PaidFunds) {
		const unit = fund.unit === '' || fund.unit.toLowerCase() === 'lovelace' ? 'lovelace' : fund.unit;
		paidAssets.set(unit, (paidAssets.get(unit) ?? 0n) + fund.amount);
	}
	const valuePlan = planL2LockValue(request.PaidFunds, (collateralReturnLovelace) => {
		// Size for the larger ResultSubmitted continuation, as the L1 path does.
		// The validator preserves value across SubmitResult, so pre-funding here
		// prevents the seller from needing a separate ADA top-up later.
		const estimateDatum = createDatumFromBlockchainIdentifierV2({
			...buildL2LockDatumParams({
				request: lockRequestFields,
				buyerAddress,
				sellerAddress,
				buyerReturnAddress,
				collateralReturnLovelace,
			}),
			resultHash: DUMMY_RESULT_HASH,
			state: SmartContractState.ResultSubmitted,
		});
		const bufferedMinimum = calculateMinUtxo({
			datum: estimateDatum.value,
			nativeTokenCount,
			coinsPerUtxoSize: coinsPerUtxoSize,
			includeBuffers: true,
		}).minUtxoLovelace;
		const amount = [...paidAssets].map(([unit, quantity]) => ({ unit, quantity: quantity.toString() }));
		const ada = (paidAssets.get('lovelace') ?? 0n) + collateralReturnLovelace;
		const outputAssets = amount.filter((asset) => asset.unit !== 'lovelace');
		outputAssets.push({ unit: 'lovelace', quantity: ada.toString() });
		const serializedMinimum = getOutputMinLovelace(
			{
				address: smartContractAddress,
				amount: outputAssets,
				datum: { type: 'Inline', data: { type: 'Mesh', content: estimateDatum.value } },
			},
			coinsPerUtxoSize,
		);
		return serializedMinimum > bufferedMinimum ? serializedMinimum : bufferedMinimum;
	});
	const datum = createDatumFromBlockchainIdentifierV2(
		buildL2LockDatumParams({
			request: lockRequestFields,
			buyerAddress,
			sellerAddress,
			buyerReturnAddress,
			collateralReturnLovelace: valuePlan.collateralReturnLovelace,
		}),
	);

	return { valuePlan, datum };
}
