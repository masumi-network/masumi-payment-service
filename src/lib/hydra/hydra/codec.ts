import type { Asset, UTxO } from '@meshsdk/core';

import type { HydraUTxO, HydraValue } from './types';

export function mapAmountToHydraValue(amount: Asset[]): HydraValue {
	return Object.fromEntries(amount.map((asset) => [asset.unit, Number(asset.quantity)]));
}

export function mapHydraValueToAmount(hydraValue: HydraValue): Asset[] {
	return Object.entries(hydraValue).map(([key, amount]) => ({
		unit: key,
		quantity: amount.toString(),
	}));
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
