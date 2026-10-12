import { PlutusData, PlutusDatumSchema } from '@emurgo/cardano-serialization-lib-nodejs';
import type { Asset, UTxO } from '@meshsdk/core';

import { MAX_HYDRA_QUANTITY } from './schemas';
import type { HydraQuantity, HydraUTxO, HydraValue } from './types';

export function mapAmountToHydraValue(amount: Asset[]): HydraValue {
	// Null-prototype for the same reason the guard below is there: assigning
	// `__proto__` on an object literal sets the prototype instead of creating the
	// key, so that asset would vanish from the value rather than be carried.
	const value = Object.create(null) as HydraValue;

	for (const asset of amount) {
		if (asset.unit === 'lovelace') {
			value.lovelace = toHydraQuantity(asset.quantity, asset.unit);
			continue;
		}

		const policyId = asset.unit.slice(0, 56);
		const assetName = asset.unit.slice(56);
		// `Object.hasOwn`, because a unit shorter than 56 characters makes the slice
		// return the whole string — and `value['__proto__']` is then Object.prototype,
		// which passes the object test below and takes the asset-name write with it.
		const policyValue = Object.hasOwn(value, policyId) ? value[policyId] : undefined;
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

	const inlineDatumRaw = utxo.output.plutusData ?? null;
	return {
		address: utxo.output.address,
		value: mapAmountToHydraValue(utxo.output.amount),
		// Blockfrost reports the hash of an inline datum as `dataHash` too; sending it
		// as `datumhash` would describe a second, hash-only datum on the same output.
		datumhash: inlineDatumRaw == null ? (utxo.output.dataHash ?? null) : null,
		inlineDatum: inlineDatumRaw == null ? null : inlineDatumJson(inlineDatumRaw),
		inlineDatumRaw,
		datum: null,
		referenceScript: null,
	};
}

/**
 * hydra-node 2.4.1 reads `inlineDatumRaw` to keep the original bytes, but then
 * hands the output to cardano-api's parser, which only builds an inline datum
 * when `inlineDatum` (detailed-schema JSON) is present as well
 * (`Hydra.Cardano.Api.TxOut.parseTxOutFromJSON`).
 */
function inlineDatumJson(rawHex: string): object {
	return JSON.parse(PlutusData.from_hex(rawHex).to_json(PlutusDatumSchema.DetailedSchema)) as object;
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
