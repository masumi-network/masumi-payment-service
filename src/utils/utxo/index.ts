import { UTxO } from '@meshsdk/core';

const DEFAULT_MIN_COLLATERAL_LOVELACE = 5_000_000n;

export function getLovelaceFromUtxo(utxo: UTxO): bigint {
	return BigInt(utxo.output.amount.find((asset) => asset.unit === 'lovelace' || asset.unit === '')?.quantity ?? '0');
}

/**
 * Sorts UTXOs by lovelace amount in descending order (O(n log n))
 */
export function sortUtxosByLovelaceDesc(utxos: UTxO[]): UTxO[] {
	return [...utxos].sort((a, b) => {
		const aLovelace = getLovelaceFromUtxo(a);
		const bLovelace = getLovelaceFromUtxo(b);
		return aLovelace === bLovelace ? 0 : aLovelace > bLovelace ? -1 : 1;
	});
}

function sortUtxosByBloatAsc(utxos: UTxO[]): UTxO[] {
	return [...utxos].sort((a, b) => {
		const assetCountComparison = a.output.amount.length - b.output.amount.length;
		if (assetCountComparison !== 0) {
			return assetCountComparison;
		}
		const aLovelace = getLovelaceFromUtxo(a);
		const bLovelace = getLovelaceFromUtxo(b);
		return aLovelace === bLovelace ? 0 : aLovelace > bLovelace ? -1 : 1;
	});
}

/**
 * Limits UTXOs to the smallest prefix that covers the required lovelace.
 * Native-token-heavy UTxOs are considered last to keep transaction size down.
 */
function limitUtxos(utxos: UTxO[], requiredLovelace: bigint): UTxO[] {
	const selectedUtxos: UTxO[] = [];
	let accumulatedLovelace = 0n;
	for (const utxo of utxos) {
		if (accumulatedLovelace >= requiredLovelace) {
			break;
		}
		accumulatedLovelace += getLovelaceFromUtxo(utxo);
		selectedUtxos.push(utxo);
	}
	if (accumulatedLovelace < requiredLovelace) {
		throw new Error(
			`Insufficient UTxO balance: required ${requiredLovelace.toString()} lovelace, found ${accumulatedLovelace.toString()}`,
		);
	}
	return selectedUtxos;
}

/**
 * Combined function: sort and limit UTXOs in one operation
 */
export function sortAndLimitUtxos(utxos: UTxO[], requiredLovelace: number | bigint): UTxO[] {
	const sortedUtxos = sortUtxosByBloatAsc(utxos);
	return limitUtxos(sortedUtxos, BigInt(requiredLovelace));
}

/**
 * Selects a collateral input.
 *
 * Prefer the smallest qualifying pure-ADA UTxO so native tokens do not need
 * a collateral-return output. If none exists, fall back to the smallest
 * qualifying mixed-asset UTxO: Babbage/CIP-40 permits token-bearing
 * collateral, and Mesh emits the required collateral-return output.
 */
export function selectCollateralUtxo(
	utxos: UTxO[],
	minimumLovelace: number | bigint = DEFAULT_MIN_COLLATERAL_LOVELACE,
): UTxO {
	const requiredLovelace = BigInt(minimumLovelace);
	const qualifyingUtxos = utxos
		.filter((utxo) => utxo.output.amount.length > 0 && getLovelaceFromUtxo(utxo) >= requiredLovelace)
		.map((utxo) => ({
			utxo,
			isPureAda: utxo.output.amount.every((asset) => asset.unit === 'lovelace' || asset.unit === ''),
			lovelace: getLovelaceFromUtxo(utxo),
		}))
		.sort((left, right) => {
			if (left.isPureAda !== right.isPureAda) {
				return left.isPureAda ? -1 : 1;
			}
			if (left.lovelace < right.lovelace) return -1;
			if (left.lovelace > right.lovelace) return 1;
			return 0;
		});

	const collateralUtxo = qualifyingUtxos[0]?.utxo;
	if (!collateralUtxo) {
		throw new Error(`Collateral UTxO not found with at least ${requiredLovelace.toString()} lovelace`);
	}
	return collateralUtxo;
}
