import type { Asset, UTxO } from '@meshsdk/core';

import type { HydraUTxO, HydraValue } from './types';

export function mapAmountToHydraValue(amount: Asset[]): HydraValue {
	const value: HydraValue = {};

	for (const asset of amount) {
		if (asset.unit === 'lovelace') {
			value.lovelace = Number(asset.quantity);
			continue;
		}

		const policyId = asset.unit.slice(0, 56);
		const assetName = asset.unit.slice(56);
		const policyValue = value[policyId];
		const nestedPolicyValue =
			policyValue != null && typeof policyValue === 'object' && !Array.isArray(policyValue) ? policyValue : {};

		nestedPolicyValue[assetName] = Number(asset.quantity);
		value[policyId] = nestedPolicyValue;
	}

	return value;
}

export function mapHydraValueToAmount(hydraValue: HydraValue): Asset[] {
	return Object.entries(hydraValue).flatMap(([key, amount]) => {
		if (amount == null) {
			return [];
		}

		if (typeof amount === 'number') {
			return [
				{
					unit: key,
					quantity: amount.toString(),
				},
			];
		}

		return Object.entries(amount).map(([assetName, quantity]) => ({
			unit: `${key}${assetName}`,
			quantity: quantity.toString(),
		}));
	});
}

export function mapUTxOToHydraUTxO(utxo: UTxO): HydraUTxO {
	return {
		address: utxo.output.address,
		value: mapAmountToHydraValue(utxo.output.amount),
		datumhash: utxo.output.dataHash ?? null,
		inlineDatum: null,
		inlineDatumRaw: utxo.output.plutusData ?? null,
		datum: null,
		referenceScript: null,
	};
}

export function mapHydraUTxOToUTxO(txId: string, utxo: HydraUTxO): UTxO {
	const [txHash, outputIndex] = txId.split('#');
	if (!txHash || !outputIndex) {
		throw new Error(`Invalid txId: ${txId}`);
	}

	return {
		input: {
			txHash: txHash,
			outputIndex: Number(outputIndex),
		},
		output: {
			address: utxo.address,
			amount: mapHydraValueToAmount(utxo.value),
			dataHash: utxo.datumhash ?? undefined,
			plutusData: utxo.inlineDatumRaw ?? undefined,
		},
	};
}
