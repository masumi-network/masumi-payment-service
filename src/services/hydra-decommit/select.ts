/**
 * Choosing which in-head UTxOs a withdrawal may take.
 *
 * Withdrawing is the one Hydra operation that can quietly break the head it acts
 * on. A top-up that picks badly just moves less money than intended; a
 * withdrawal that picks badly can leave a wallet holding escrows it can no
 * longer spend, and the only way out of that is closing the head. So the
 * selection is deliberately conservative and every exclusion here is a rule
 * about what must stay behind, not an optimisation.
 *
 * Pure and provider-free, so the rules can be tested without a head.
 */

import type { UTxO } from '@meshsdk/core';

/**
 * Lovelace kept in a spendable UTxO so the wallet can still post script
 * transactions inside the head.
 *
 * The head's parameters charge no fee, which makes it easy to believe a wallet
 * needs nothing left over. It does: spending the escrow script requires
 * collateral, and collateral must be a plain UTxO the wallet already holds.
 * Withdraw the last one and every future submit-result, refund and collect in
 * this head fails with nothing to offer as collateral — while the balance
 * still reads as healthy, because the escrows themselves are untouched.
 *
 * Matches COLLATERAL_RESERVE_LOVELACE in the V2 collateral service, which is
 * what actually picks collateral at build time. Duplicated rather than imported
 * because that module sits on the V2 mesh line (ADR-0005) and this one does not.
 */
export const IN_HEAD_COLLATERAL_RESERVE_LOVELACE = 5_000_000n;

export interface DecommitSelectionInput {
	/** The local participant's in-head UTxOs, as the head reports them. */
	utxos: readonly UTxO[];
	/** Refs the head has promised to a deposit but not yet folded in. */
	pendingIncrementRefs: ReadonlySet<string>;
	/**
	 * Take everything, including the collateral reserve.
	 *
	 * For winding a head down, where being unable to post further script
	 * transactions is the intent rather than an accident.
	 */
	drain: boolean;
}

export interface DecommitSelectionResult {
	/** UTxOs this withdrawal is allowed to spend. */
	eligible: UTxO[];
	/** Total lovelace across the eligible set. */
	eligibleLovelace: bigint;
	/** Why each excluded UTxO was held back, keyed by `txHash#index`. */
	excluded: Map<string, string>;
}

export function utxoRef(utxo: UTxO): string {
	return `${utxo.input.txHash}#${utxo.input.outputIndex}`.toLowerCase();
}

export function lovelaceOf(utxo: UTxO): bigint {
	return amountOf(utxo, '');
}

/** How much of one asset a UTxO holds. Empty unit means lovelace. */
export function amountOf(utxo: UTxO, unit: string): bigint {
	const wanted = unit === '' || unit.toLowerCase() === 'lovelace' ? ['', 'lovelace'] : [unit.toLowerCase()];
	let total = 0n;
	for (const asset of utxo.output.amount) {
		if (wanted.includes(asset.unit.toLowerCase())) total += BigInt(asset.quantity);
	}
	return total;
}

/**
 * A UTxO that is only money, and nothing else.
 *
 * Anything carrying a datum or a reference script is part of some arrangement —
 * an escrow, a reference input — and taking it out of the head would remove it
 * from whatever depends on it while leaving that thing looking intact. The
 * participant's own address should never hold one; refusing them anyway costs
 * nothing and is the difference between a bug and a broken head.
 */
function isPlainValue(utxo: UTxO): boolean {
	return (
		(utxo.output.dataHash === undefined || utxo.output.dataHash === null) &&
		(utxo.output.plutusData === undefined || utxo.output.plutusData === null) &&
		(utxo.output.scriptRef === undefined || utxo.output.scriptRef === null) &&
		(utxo.output.scriptHash === undefined || utxo.output.scriptHash === null)
	);
}

/**
 * Apply every rule about what must stay in the head, and report what is left.
 *
 * The collateral reserve is withheld as a whole UTxO rather than as an amount:
 * collateral cannot be assembled from several inputs at build time, so leaving
 * 5 ADA spread over three UTxOs would satisfy an amount check and still leave
 * the wallet unable to post anything.
 */
export function selectDecommittableUtxos(input: DecommitSelectionInput): DecommitSelectionResult {
	const excluded = new Map<string, string>();
	const candidates: UTxO[] = [];

	for (const utxo of input.utxos) {
		const ref = utxoRef(utxo);
		if (input.pendingIncrementRefs.has(ref)) {
			excluded.set(ref, 'still being folded into the head by a deposit');
			continue;
		}
		if (!isPlainValue(utxo)) {
			excluded.set(ref, 'carries a datum or script, so it is not plain funds');
			continue;
		}
		candidates.push(utxo);
	}

	if (!input.drain) {
		// Hold back the smallest UTxO that can serve as collateral on its own.
		// Smallest, so the reserve costs the withdrawal as little as possible;
		// whole, because that is how collateral is chosen.
		const reserveIndex = candidates
			.map((utxo, index) => ({ index, lovelace: lovelaceOf(utxo) }))
			.filter((entry) => entry.lovelace >= IN_HEAD_COLLATERAL_RESERVE_LOVELACE)
			.sort((left, right) => (left.lovelace === right.lovelace ? 0 : left.lovelace < right.lovelace ? -1 : 1))[0];

		if (reserveIndex === undefined) {
			// Nothing here could act as collateral even before the withdrawal, so
			// there is nothing to protect. Say so rather than silently taking it all.
			return {
				eligible: candidates,
				eligibleLovelace: candidates.reduce((total, utxo) => total + lovelaceOf(utxo), 0n),
				excluded,
			};
		}
		const [reserved] = candidates.splice(reserveIndex.index, 1);
		if (reserved) {
			excluded.set(utxoRef(reserved), 'kept back as collateral so this wallet can still spend escrows in the head');
		}
	}

	return {
		eligible: candidates,
		eligibleLovelace: candidates.reduce((total, utxo) => total + lovelaceOf(utxo), 0n),
		excluded,
	};
}

/**
 * The fewest whole UTxOs whose lovelace reaches `amount`.
 *
 * Largest first, so a withdrawal spends as few inputs as possible and leaves the
 * wallet's remaining UTxOs as usable as it found them. Returns null when the
 * eligible set cannot reach the amount at all — the caller reports that as a
 * refusal rather than withdrawing an unexpected sum.
 */
export function coverLovelace(utxos: readonly UTxO[], amount: bigint): UTxO[] | null {
	return coverAsset(utxos, '', amount);
}

/**
 * Whether an asset withdrawal can spend these inputs as they are.
 *
 * Holding the right quantity is not enough. A decommit removes whole outputs,
 * so a UTxO carrying 1000 tUSDM alongside 450 ADA would send both out when only
 * the token was asked for. The asset is therefore carved onto its own UTxO
 * first, and the carve is skipped only when the input already is what the carve
 * would produce: one UTxO, this asset and no other, and no more lovelace than
 * `carrierLovelace`, which is what an output needs to exist at all.
 */
export function isAlreadyCarved(
	utxos: readonly UTxO[],
	unit: string,
	amount: bigint,
	carrierLovelace: bigint,
): boolean {
	const [only] = utxos;
	if (utxos.length !== 1 || only === undefined) return false;
	if (amountOf(only, unit) !== amount) return false;
	if (lovelaceOf(only) > carrierLovelace) return false;
	return only.output.amount.every(
		(asset) =>
			asset.unit === '' || asset.unit.toLowerCase() === 'lovelace' || asset.unit.toLowerCase() === unit.toLowerCase(),
	);
}

/**
 * The fewest whole UTxOs whose `unit` holding reaches `amount`.
 *
 * Largest first, so a withdrawal spends as few inputs as possible and leaves the
 * wallet's remaining UTxOs as usable as it found them. Returns null when the
 * eligible set cannot reach the amount at all: the caller reports that as a
 * refusal rather than withdrawing an unexpected sum.
 */
export function coverAsset(utxos: readonly UTxO[], unit: string, amount: bigint): UTxO[] | null {
	const sorted = [...utxos].sort((left, right) => {
		const difference = amountOf(right, unit) - amountOf(left, unit);
		return difference === 0n ? 0 : difference < 0n ? -1 : 1;
	});
	const chosen: UTxO[] = [];
	let total = 0n;
	for (const utxo of sorted) {
		if (total >= amount) break;
		// A UTxO holding none of the asset only adds size to the transaction.
		if (amountOf(utxo, unit) === 0n) continue;
		chosen.push(utxo);
		total += amountOf(utxo, unit);
	}
	return total >= amount ? chosen : null;
}

/**
 * Extra inputs so a carve has enough lovelace to pay for its own outputs.
 *
 * Carving a token needs `needed` lovelace across the inputs: enough to put on
 * the carved output, plus enough left over for the remainder to be a legal UTxO.
 * The UTxOs holding the token frequently do not have it — a token minted onto a
 * bare minimum-ADA output is the normal case, not an edge one — and without this
 * a partial withdrawal of that token was simply impossible, with an error
 * message suggesting a whole-UTxO withdrawal that could not express it either.
 *
 * Asset-free UTxOs first, then smallest first. Ordering by size alone would
 * happily borrow a token-heavy UTxO, and every asset on a borrowed input lands
 * on the carve's change output — where the minimum ADA a UTxO needs grows with
 * the assets it holds, so the change can fall below it and the builder fails
 * with a value-conservation error that names neither the borrow nor the amount.
 *
 * Returns null when even every eligible UTxO together falls short.
 */
export function topUpCarveInputs(params: {
	chosen: readonly UTxO[];
	eligible: readonly UTxO[];
	needed: bigint;
}): UTxO[] | null {
	const { chosen, eligible, needed } = params;
	const taken = new Set(chosen.map(utxoRef));
	let total = chosen.reduce((sum, utxo) => sum + lovelaceOf(utxo), 0n);
	const extra: UTxO[] = [];
	if (total >= needed) return extra;

	const spare = eligible
		.filter((utxo) => !taken.has(utxoRef(utxo)))
		.sort((left, right) => {
			const byAssets = countNativeAssets(left) - countNativeAssets(right);
			if (byAssets !== 0) return byAssets;
			const difference = lovelaceOf(left) - lovelaceOf(right);
			return difference === 0n ? 0 : difference < 0n ? -1 : 1;
		});

	for (const utxo of spare) {
		if (total >= needed) break;
		if (lovelaceOf(utxo) === 0n) continue;
		extra.push(utxo);
		total += lovelaceOf(utxo);
	}
	return total >= needed ? extra : null;
}

/** How many distinct native assets a UTxO carries. Lovelace is not one. */
export function countNativeAssets(utxo: UTxO): number {
	const units = new Set<string>();
	for (const asset of utxo.output.amount) {
		if (asset.unit === '' || asset.unit.toLowerCase() === 'lovelace') continue;
		units.add(asset.unit.toLowerCase());
	}
	return units.size;
}

/**
 * The least lovelace the carve's change output can hold and still exist.
 *
 * A minimum-ADA figure is not a constant: it is charged per byte of the output,
 * and every native asset that does not leave on the carved output ends up on the
 * change. Withdrawing one token from a wallet that holds a dozen therefore needs
 * a bigger remainder than the flat two ADA a plain output needs, and using the
 * flat figure meant the split was built and only then refused by the ledger.
 *
 * Approximate and deliberately generous. Being a little over costs the operator
 * nothing — the change returns to their own address inside the head — while
 * being under costs them a failed withdrawal with an opaque reason.
 */
export function requiredChangeLovelace(params: {
	inputs: readonly UTxO[];
	carvedUnit: string;
	carvedAmount: bigint;
	baseLovelace: bigint;
	perAssetLovelace: bigint;
}): bigint {
	const { inputs, carvedUnit, carvedAmount, baseLovelace, perAssetLovelace } = params;
	const remaining = new Map<string, bigint>();
	for (const utxo of inputs) {
		for (const asset of utxo.output.amount) {
			if (asset.unit === '' || asset.unit.toLowerCase() === 'lovelace') continue;
			const unit = asset.unit.toLowerCase();
			remaining.set(unit, (remaining.get(unit) ?? 0n) + BigInt(asset.quantity));
		}
	}
	const carved = carvedUnit === '' || carvedUnit.toLowerCase() === 'lovelace' ? null : carvedUnit.toLowerCase();
	if (carved !== null) {
		const left = (remaining.get(carved) ?? 0n) - carvedAmount;
		if (left <= 0n) remaining.delete(carved);
		else remaining.set(carved, left);
	}
	return baseLovelace + perAssetLovelace * BigInt(remaining.size);
}
