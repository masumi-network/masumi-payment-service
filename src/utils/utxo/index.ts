import { UTxO } from '@meshsdk/core';

/**
 * Reads the lovelace quantity off a UTxO as `bigint`.
 *
 * Cardano lovelace quantities can exceed `Number.MAX_SAFE_INTEGER`
 * (2^53 - 1 ≈ 9.0e15). Mainnet has individual whale UTxOs above this
 * boundary, and the protocol-allowed maximum (~45e15 lovelace = 45M ADA
 * per UTxO with the current supply) cannot fit in a JS Number without
 * truncation. Project rule (CLAUDE.md): use BigInt for all monetary
 * amounts; never use Number for lovelace values.
 */
function getLovelaceFromUtxo(utxo: UTxO): bigint {
	return BigInt(utxo.output.amount.find((asset) => asset.unit === 'lovelace' || asset.unit === '')?.quantity ?? '0');
}

/**
 * Sorts UTXOs by lovelace amount in descending order (O(n log n)).
 *
 * Uses BigInt comparisons throughout — see `getLovelaceFromUtxo`. The
 * comparator cannot return `bigint`, so it converts the sign of the
 * BigInt diff to `-1 / 0 / 1`.
 */
export function sortUtxosByLovelaceDesc(utxos: UTxO[]): UTxO[] {
	const utxosWithLovelace = utxos.map((utxo) => ({
		utxo,
		lovelace: getLovelaceFromUtxo(utxo),
	}));

	return utxosWithLovelace
		.sort((a, b) => {
			if (b.lovelace > a.lovelace) return 1;
			if (b.lovelace < a.lovelace) return -1;
			return 0;
		})
		.map((item) => item.utxo);
}

function sortUtxosByBloatAsc(utxos: UTxO[]): UTxO[] {
	// `.slice()` first so the in-place `.sort()` doesn't mutate the caller's
	// array. `sortUtxosByLovelaceDesc` above already produces a fresh array via
	// `.map(...).sort()`; mirror that immutability guarantee here.
	return utxos.slice().sort((a, b) => a.output.amount.length - b.output.amount.length);
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
	const nonEmpty = utxos.filter((utxo) => getLovelaceFromUtxo(utxo) > 0n);
	if (nonEmpty.length === 0) {
		throw new Error('No suitable UTXOs found');
	}
	const selectedUtxos: UTxO[] = [];
	let accumulatedLovelace = 0n;
	// requiredLovelace stays `number` for caller ergonomics — callers pass
	// small literals like 8_000_000 (8 ADA). BigInt comparisons require both
	// sides to be bigint, so coerce once up front. requiredLovelace is well
	// inside safe range so no precision loss.
	const requiredLovelaceBig = BigInt(requiredLovelace);
	for (const utxo of nonEmpty) {
		if (accumulatedLovelace > requiredLovelaceBig) {
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
