import type { UTxO } from '@meshsdk/core';

export type CommitUtxoSelection = {
	commitUtxos: UTxO[];
	excludedUtxos: UTxO[];
	/**
	 * Whether the selection actually covers the target it was given.
	 *
	 * Only meaningful for `selectCommitUtxosUpToTarget`, and reported because
	 * the unreachable case is not an empty selection — it is EVERY matching
	 * UTxO, best-effort. A caller that reads "non-empty" as "worked" therefore
	 * commits the whole wallet balance when the target is out of reach.
	 */
	reachedTarget?: boolean;
};

/**
 * Which wallet UTxOs a commit/top-up should draw from.
 * - `all`: every plain UTxO (the whole plain wallet balance).
 * - `ada-only`: plain UTxOs holding ONLY lovelace (no native assets).
 * - `{ unit }`: plain UTxOs that contain the given native-asset unit
 *   (`policyId + assetNameHex`).
 * - `{ unit, exclusive: true }`: as above, but only UTxOs carrying nothing
 *   else. Hydra commits WHOLE UTxOs, and a wallet's change consolidates —
 *   so a UTxO holding the target token alongside an agent's registry NFT is
 *   routinely the smallest one covering the amount, and committing it takes
 *   the NFT into the head with it, off L1 and out of reach of any registry
 *   update until someone decommits or closes the head.
 */
export type CommitUtxoFilter = 'all' | 'ada-only' | { unit: string; exclusive?: boolean };

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

/** Holds the target unit and nothing else beyond lovelace. */
function containsOnlyUnit(utxo: UTxO, unit: string): boolean {
	const target = unit.toLowerCase();
	if (!containsUnit(utxo, unit)) return false;
	return utxo.output.amount.every((asset) => {
		const assetUnit = asset.unit.toLowerCase();
		return assetUnit === 'lovelace' || assetUnit === target;
	});
}

function matchesFilter(utxo: UTxO, filter: CommitUtxoFilter): boolean {
	if (filter === 'all') return true;
	if (filter === 'ada-only') return hasOnlyLovelace(utxo);
	return filter.exclusive === true ? containsOnlyUnit(utxo, filter.unit) : containsUnit(utxo, filter.unit);
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
 * Select matching plain UTxOs whose combined `target.unit` amount reaches
 * `target.amount`, overshooting as little as possible.
 *
 * Hydra commits whole UTxOs, so the committed amount is always >= the target
 * and the only question is by how much. Taking the largest first minimises the
 * number of inputs but maximises that excess: an unattended 10 ADA top-up
 * against a wallet holding one 5 000 ADA UTxO put the whole 5 000 into the
 * head, recoverable only by a decommit or a close — on mainnet, behind the
 * contestation window.
 *
 * So the smallest UTxO that covers the target on its own wins: one input, and
 * the least excess available. Only when nothing covers it alone does this
 * accumulate largest-first, which keeps the input count down and still bounds
 * the excess below the target, since every remaining candidate is smaller than
 * it. If the wallet cannot reach the target at all, every matching UTxO is
 * committed (best effort). Non-matching and unused matching UTxOs are returned
 * as excluded.
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
	const smallestSufficient = [...sorted].reverse().find((utxo) => unitAmount(utxo, target.unit) >= target.amount);
	if (smallestSufficient !== undefined) {
		commitUtxos.push(smallestSufficient);
		const onlyChosen = new Set(commitUtxos);
		return {
			commitUtxos,
			excludedUtxos: [...excludedUtxos, ...matching.filter((utxo) => !onlyChosen.has(utxo))],
			reachedTarget: true,
		};
	}

	let accumulated = 0n;
	for (const utxo of sorted) {
		if (accumulated >= target.amount) break;
		commitUtxos.push(utxo);
		accumulated += unitAmount(utxo, target.unit);
	}
	const chosen = new Set(commitUtxos);
	return {
		commitUtxos,
		excludedUtxos: [...excludedUtxos, ...matching.filter((utxo) => !chosen.has(utxo))],
		reachedTarget: accumulated >= target.amount,
	};
}
