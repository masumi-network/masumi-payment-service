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
function limitUtxos(utxos: UTxO[], requiredLovelace: number): UTxO[] {
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
 * Pick a UTxO suitable for use as collateral, excluding the one referenced by
 * `exclude` (the UTxO consumed as a spending input). Conway-era ledger rules
 * reject a tx where a collateral UTxO also appears in the spending inputs
 * (CIP-40 + Conway phase-1 validation). The symptom on submission/eval is an
 * `EvaluationFailure` with an empty `ScriptFailures` map — a generic phase-1
 * failure that hides the real reason. Pass the spending UTxO here and the
 * helper returns a different pure-ADA UTxO with at least `requiredLovelace`.
 *
 * Throws if no suitable collateral UTxO is available. Mesh's tx builder sets
 * total-collateral at 3 ADA in our register/deregister flows, so 5 ADA is a
 * safe default minimum (accounts for the implicit 1.5x collateral percentage
 * applied by the ledger).
 */
export function pickCollateralUtxo(
	utxos: UTxO[],
	exclude: { input: { txHash: string; outputIndex: number } },
	requiredLovelace: number = 5_000_000,
): UTxO {
	const excludeKey = `${exclude.input.txHash}#${exclude.input.outputIndex}`;
	const candidates = utxos.filter((utxo) => {
		if (`${utxo.input.txHash}#${utxo.input.outputIndex}` === excludeKey) return false;
		// Pure-ADA only: collateral with native tokens is technically allowed
		// post-Conway but mesh's default collateral-return setup doesn't handle
		// it. Stay conservative.
		const onlyLovelace = utxo.output.amount.every(
			(asset) => asset.unit === '' || asset.unit.toLowerCase() === 'lovelace',
		);
		if (!onlyLovelace) return false;
		const lovelace = parseInt(
			utxo.output.amount.find((asset) => asset.unit === '' || asset.unit === 'lovelace')?.quantity ?? '0',
		);
		return lovelace >= requiredLovelace;
	});
	// Take the smallest qualifying UTxO so we don't burn a big one as
	// collateral when it could be used as a spending input on a later tx.
	const sorted = sortUtxosByLovelaceDesc(candidates).reverse();
	const picked = sorted[0];
	if (picked == null) {
		throw new Error(
			'No collateral UTxO available: wallet has no pure-ADA UTxO ' +
				`with >= ${requiredLovelace} lovelace that is not also the spending input.`,
		);
	}
	return picked;
}
