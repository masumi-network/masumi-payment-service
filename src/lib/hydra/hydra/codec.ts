import type { Asset, UTxO } from '@meshsdk/core';

import { MAX_HYDRA_QUANTITY } from './schemas';
import type { HydraQuantity, HydraUTxO, HydraValue } from './types';

export function mapAmountToHydraValue(amount: Asset[]): HydraValue {
	const value: HydraValue = {};

	for (const asset of amount) {
		if (asset.unit === 'lovelace') {
			value.lovelace = toHydraQuantity(asset.quantity, asset.unit);
			continue;
		}

		const policyId = asset.unit.slice(0, 56);
		const assetName = asset.unit.slice(56);
		const policyValue = value[policyId];
		const nestedPolicyValue =
			policyValue != null && typeof policyValue === 'object' && !Array.isArray(policyValue) ? policyValue : {};

		nestedPolicyValue[assetName] = toHydraQuantity(asset.quantity, asset.unit);
		value[policyId] = nestedPolicyValue;
	}

	return value;
}

export function mapHydraValueToAmount(hydraValue: HydraValue): Asset[] {
	return Object.entries(hydraValue).flatMap(([key, amount]) => {
		if (amount == null) {
			return [];
		}

		if (typeof amount === 'number' || typeof amount === 'bigint') {
			return [
				{
					unit: key,
					quantity: assertHydraQuantity(amount, key).toString(),
				},
			];
		}

		return Object.entries(amount).map(([assetName, quantity]) => ({
			unit: `${key}${assetName}`,
			quantity: assertHydraQuantity(quantity, `${key}${assetName}`).toString(),
		}));
	});
}

function toHydraQuantity(quantity: string, unit: string): bigint {
	let integer: bigint;
	try {
		integer = BigInt(quantity);
	} catch {
		throw new Error(`Invalid Hydra quantity ${JSON.stringify(quantity)} for asset ${unit}`);
	}

	if (integer < 0n || integer > MAX_HYDRA_QUANTITY) {
		throw new Error(`Hydra quantity ${quantity} for asset ${unit} is outside the Cardano uint64 range`);
	}

	return integer;
}

function assertHydraQuantity(quantity: HydraQuantity, unit: string): bigint {
	if (typeof quantity === 'number' && !Number.isSafeInteger(quantity)) {
		throw new Error(`Hydra quantity ${quantity} for asset ${unit} is not an exact JSON integer`);
	}
	const integer = BigInt(quantity);
	if (integer < 0n || integer > MAX_HYDRA_QUANTITY) {
		throw new Error(`Hydra quantity ${quantity} for asset ${unit} is outside the Cardano uint64 range`);
	}
	return integer;
}

export function mapUTxOToHydraUTxO(utxo: UTxO): HydraUTxO {
	if (utxo.output.scriptRef != null) {
		throw new Error(
			`Cannot map reference-script UTxO ${utxo.input.txHash}#${utxo.input.outputIndex} to Hydra commit JSON`,
		);
	}

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
