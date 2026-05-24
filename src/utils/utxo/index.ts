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
	// `.slice()` first so the in-place `.sort()` doesn't mutate the caller's
	// array. `sortUtxosByLovelaceDesc` above already produces a fresh array via
	// `.map(...).sort()`; mirror that immutability guarantee here.
	return utxos.slice().sort((a, b) => a.output.amount.length - b.output.amount.length);
}

function getLovelaceFromUtxo(utxo: UTxO): number {
	return parseInt(utxo.output.amount.find((asset) => asset.unit === 'lovelace' || asset.unit === '')?.quantity ?? '0');
}

/**
 * Picks wallet UTxOs to cover `requiredLovelace` for tx fees and outputs.
 *
 * Earlier this function required every candidate UTxO to be >= 5 ADA on its
 * own, which made sense for the V1 single-item flow where a freshly-funded
 * buyer wallet always had at least one large change UTxO. The V2 batch flow
 * spends most of the wallet in one go (N script outputs in a single
 * batch-payments tx), so by the time the buyer-side actions run the wallet
 * typically has only sub-5-ADA change UTxOs. The hard 5 ADA per-UTxO filter
 * then returned an empty set even when the wallet's total balance comfortably
 * exceeded `requiredLovelace`, and the throw bubbled all the way up out of
 * `processWalletBatch` — silently aborting every batch tick until the test
 * timed out.
 *
 * Fix: drop the 5 ADA per-UTxO filter and let the accumulator pick whichever
 * UTxOs cover the requirement. Only completely empty inputs are skipped (the
 * `lovelace > 0` guard). Mesh's coin-selection downstream rebuilds inputs
 * anyway, so emitting extra small UTxOs here doesn't expand the tx body.
 */
function limitUtxos(utxos: UTxO[], requiredLovelace: number): UTxO[] {
	const nonEmpty = utxos.filter((utxo) => getLovelaceFromUtxo(utxo) > 0);
	if (nonEmpty.length === 0) {
		throw new Error('No suitable UTXOs found');
	}
	const selectedUtxos: UTxO[] = [];
	let accumulatedLovelace = 0;
	for (const utxo of nonEmpty) {
		if (accumulatedLovelace > requiredLovelace) {
			break;
		}
		accumulatedLovelace += getLovelaceFromUtxo(utxo);
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
