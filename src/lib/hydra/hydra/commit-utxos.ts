import type { UTxO } from '@meshsdk/core';

export type CommitUtxoSelection = {
	commitUtxos: UTxO[];
	excludedUtxos: UTxO[];
};

/**
 * Which wallet UTxOs a commit/top-up should draw from.
 * - `all`: every plain UTxO (the whole plain wallet balance).
 * - `ada-only`: plain UTxOs holding ONLY lovelace (no native assets).
 * - `{ unit }`: plain UTxOs that contain the given native-asset unit
 *   (`policyId + assetNameHex`).
 */
export type CommitUtxoFilter = 'all' | 'ada-only' | { unit: string };

/**
 * Hydra's commit codec cannot faithfully carry datum or reference-script
 * outputs from Mesh, so only plain pubkey outputs may enter a commit draft.
 */
export function isPlainCommitUtxo(utxo: UTxO): boolean {
	return utxo.output.plutusData == null && utxo.output.dataHash == null && utxo.output.scriptRef == null;
}

function hasOnlyLovelace(utxo: UTxO): boolean {
	return utxo.output.amount.every((asset) => asset.unit === 'lovelace');
}

function containsUnit(utxo: UTxO, unit: string): boolean {
	const target = unit.toLowerCase();
	return utxo.output.amount.some((asset) => asset.unit.toLowerCase() === target);
}

function matchesFilter(utxo: UTxO, filter: CommitUtxoFilter): boolean {
	if (filter === 'all') return true;
	if (filter === 'ada-only') return hasOnlyLovelace(utxo);
	return containsUnit(utxo, filter.unit);
}

/**
 * Decoupled node-key model: the hydra-node funds L1 fees, collateral and change
 * from its OWN dedicated Cardano signing key — deliberately NOT this
 * participant's funding wallet. No wallet fuel input therefore needs to be
 * reserved, and every plain (datum- and reference-script-free) wallet UTxO may
 * be committed into the head.
 *
 * A `filter` narrows the committed set for token-aware top-ups; non-plain and
 * filtered-out UTxOs are returned as `excludedUtxos`.
 */
export function selectCommitUtxos(utxos: UTxO[], filter: CommitUtxoFilter = 'all'): CommitUtxoSelection {
	const commitUtxos: UTxO[] = [];
	const excludedUtxos: UTxO[] = [];
	for (const utxo of utxos) {
		if (isPlainCommitUtxo(utxo) && matchesFilter(utxo, filter)) {
			commitUtxos.push(utxo);
		} else {
			excludedUtxos.push(utxo);
		}
	}
	return { commitUtxos, excludedUtxos };
}

function unitAmount(utxo: UTxO, unit: string): bigint {
	const target = unit.toLowerCase();
	let total = 0n;
	for (const asset of utxo.output.amount) {
		if (asset.unit.toLowerCase() === target) total += BigInt(asset.quantity);
	}
	return total;
}

/**
 * Select the MINIMAL set of matching plain UTxOs whose combined `target.unit`
 * amount reaches `target.amount` (largest-first, so the fewest inputs are
 * committed). Used to bound an automatic top-up to roughly its target: because
 * Hydra commits whole UTxOs the committed amount is >= the target, never split.
 * If the wallet cannot reach the target, every matching UTxO is committed (best
 * effort). Non-matching and unused matching UTxOs are returned as excluded.
 */
export function selectCommitUtxosUpToTarget(
	utxos: UTxO[],
	filter: CommitUtxoFilter,
	target: { unit: string; amount: bigint },
): CommitUtxoSelection {
	const { commitUtxos: matching, excludedUtxos } = selectCommitUtxos(utxos, filter);
	const sorted = [...matching].sort((a, b) => {
		const diff = unitAmount(b, target.unit) - unitAmount(a, target.unit);
		return diff > 0n ? 1 : diff < 0n ? -1 : 0;
	});

	const commitUtxos: UTxO[] = [];
	let accumulated = 0n;
	for (const utxo of sorted) {
		if (accumulated >= target.amount) break;
		commitUtxos.push(utxo);
		accumulated += unitAmount(utxo, target.unit);
	}
	const chosen = new Set(commitUtxos);
	return { commitUtxos, excludedUtxos: [...excludedUtxos, ...matching.filter((utxo) => !chosen.has(utxo))] };
}
