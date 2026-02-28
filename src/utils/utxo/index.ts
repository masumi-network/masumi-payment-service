import { UTxO } from '@meshsdk/core';

/**
 * Sorts UTXOs by lovelace amount in descending order (O(n log n))
 */
export function sortUtxosByLovelaceDesc(utxos: UTxO[]): UTxO[] {
	// Extract lovelace amounts once for better performance
	const utxosWithLovelace = utxos.map((utxo) => ({
		utxo,
		lovelace: parseInt(
			utxo.output.amount.find((asset) => asset.unit === 'lovelace' || asset.unit === '')?.quantity ?? '0',
		),
	}));

	// Sort by lovelace amount (descending)
	return utxosWithLovelace.sort((a, b) => b.lovelace - a.lovelace).map((item) => item.utxo);
}

function sortUtxosByBloatAsc(utxos: UTxO[]): UTxO[] {
	return utxos.sort((a, b) => a.output.amount.length - b.output.amount.length);
}

function filterUtxosByRequiredLovelace(utxos: UTxO[], requiredLovelace: number): UTxO[] {
	return utxos.filter((utxo) => {
		const lovelace = parseInt(
			utxo.output.amount.find((asset) => asset.unit === 'lovelace' || asset.unit === '')?.quantity ?? '0',
		);
		return lovelace >= requiredLovelace;
	});
}
/**
 * Limits UTXOs to maximum count for transaction size optimization
 */
export function limitUtxos(utxos: UTxO[], requiredLovelace: number): UTxO[] {
	const filteredUtxos = filterUtxosByRequiredLovelace(utxos, 5000000);
	if (filteredUtxos.length === 0) {
		throw new Error('No suitable UTXOs found');
	}
	const selectedUtxos = [];
	let accumulatedLovelace = 0;
	for (const utxo of filteredUtxos) {
		if (accumulatedLovelace > requiredLovelace) {
			break;
		}
		const utxoLovelace = parseInt(
			utxo.output.amount.find((asset) => asset.unit === 'lovelace' || asset.unit === '')?.quantity ?? '0',
		);
		accumulatedLovelace += utxoLovelace;
		selectedUtxos.push(utxo);
	}
	return selectedUtxos;
}

/**
 * Combined function: sort and limit UTXOs in one operation
 */
export function sortAndLimitUtxos(utxos: UTxO[], requiredLovelace: number): UTxO[] {
	const sortedUtxos = sortUtxosByBloatAsc(utxos);

	const limitedUtxos = limitUtxos(sortedUtxos, requiredLovelace);
	if (limitedUtxos.length === 0) {
		throw new Error('No suitable UTXOs found');
	}
	return limitedUtxos;
}

/**
 * Gets the UTXO with highest lovelace amount (for transaction fees)
 * Returns the first UTXO after sorting by lovelace descending
 */
export function getHighestLovelaceUtxo(utxos: UTxO[]): UTxO | undefined {
	return sortUtxosByLovelaceDesc(utxos)[0];
}
