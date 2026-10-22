import { getOutputMinLovelace, type Asset, type UTxO } from '@meshsdk/core';
import {
	IN_HEAD_COLLATERAL_RESERVE_LOVELACE,
	isPlainValue,
	lovelaceOf,
	utxoRef,
} from '@/services/hydra-decommit/select';

/**
 * The most inputs one consolidation spends.
 *
 * Every input adds bytes, and an in-head transaction is still bound by the
 * head's maxTxSize. A hundred plain inputs stay well inside the shipped 15,000;
 * a wallet holding more is consolidated in several rounds, one per request.
 */
export const MAX_CONSOLIDATION_INPUTS = 100;

export interface ConsolidationPlan {
	/** The UTxOs this consolidation spends. */
	inputs: UTxO[];
	/**
	 * The pure-ADA collateral output to create, or null when the inputs cannot
	 * spare it. Without one the wallet could not spend escrows in the head.
	 */
	collateralLovelace: bigint | null;
	/** Eligible UTxOs left for a later round because of MAX_CONSOLIDATION_INPUTS. */
	deferredCount: number;
	/** Why each UTxO the head reports was left out, keyed by `txHash#index`. */
	excluded: Map<string, string>;
}

/**
 * Pick what a consolidation spends and what it produces.
 *
 * Every plain UTxO at the participant's address is spent, datum or not: a datum
 * locks nothing at a key address, and V2 escrow payouts carry one on purpose.
 * A UTxO still being folded in by a deposit, or carrying a reference script,
 * stays where it is, for the same reasons the withdrawal leaves it alone.
 *
 * The result is two outputs: a pure-ADA collateral UTxO and one UTxO carrying
 * everything else. Returns null when there is nothing to merge.
 */
export function planConsolidation(params: {
	utxos: readonly UTxO[];
	pendingIncrementRefs: ReadonlySet<string>;
	address: string;
	coinsPerUtxoSize: number;
}): ConsolidationPlan | null {
	const excluded = new Map<string, string>();
	const candidates: UTxO[] = [];
	for (const utxo of params.utxos) {
		const ref = utxoRef(utxo);
		if (params.pendingIncrementRefs.has(ref)) {
			excluded.set(ref, 'still being folded into the head by a deposit');
			continue;
		}
		if (!isPlainValue(utxo)) {
			excluded.set(ref, 'carries a reference script, so other transactions may depend on it');
			continue;
		}
		candidates.push(utxo);
	}

	// Smallest first, so a capped round merges the dust it exists for. The
	// largest UTxO always joins, so the merged output can carry the tokens.
	const ordered = candidates.slice().sort((left, right) => compareBigInt(lovelaceOf(left), lovelaceOf(right)));
	const inputs =
		ordered.length > MAX_CONSOLIDATION_INPUTS
			? [...ordered.slice(0, MAX_CONSOLIDATION_INPUTS - 1), ordered[ordered.length - 1]]
			: ordered;
	const deferredCount = candidates.length - inputs.length;

	const totals = sumValue(inputs);
	const restLovelace = (totals.get('lovelace') ?? 0n) - IN_HEAD_COLLATERAL_RESERVE_LOVELACE;
	const rest: Asset[] = [...totals.entries()]
		.filter(([unit]) => unit !== 'lovelace')
		.map(([unit, quantity]) => ({ unit, quantity: quantity.toString() }));
	rest.push({ unit: 'lovelace', quantity: (restLovelace > 0n ? restLovelace : 0n).toString() });
	const restMinimum = getOutputMinLovelace({ address: params.address, amount: rest }, params.coinsPerUtxoSize);
	const collateralLovelace = restLovelace >= restMinimum ? IN_HEAD_COLLATERAL_RESERVE_LOVELACE : null;

	// With collateral split off, two inputs become two outputs, which merges
	// nothing. Without it, one input has nothing to merge with.
	const outputCount = collateralLovelace === null ? 1 : 2;
	if (inputs.length <= outputCount) return null;

	return { inputs, collateralLovelace, deferredCount, excluded };
}

function sumValue(utxos: readonly UTxO[]): Map<string, bigint> {
	const totals = new Map<string, bigint>();
	for (const utxo of utxos) {
		for (const asset of utxo.output.amount) {
			const unit = asset.unit === '' || asset.unit.toLowerCase() === 'lovelace' ? 'lovelace' : asset.unit;
			totals.set(unit, (totals.get(unit) ?? 0n) + BigInt(asset.quantity));
		}
	}
	return totals;
}

const compareBigInt = (left: bigint, right: bigint): number => (left === right ? 0 : left < right ? -1 : 1);
