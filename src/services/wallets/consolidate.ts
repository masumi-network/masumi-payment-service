/**
 * Merging an L1 hot wallet's UTxOs, as a fund transfer back to itself.
 *
 * A self-transfer of nearly the whole balance makes the transfer's coin
 * selection spend nearly every UTxO, and its change and output come back to the
 * same address. Riding the fund-transfer pipeline keeps everything that makes a
 * transfer safe: the wallet lock, the pre-submit intendedTxHash, and the
 * confirmation job.
 */

import createHttpError from 'http-errors';

/**
 * Lovelace held back from the transfer amount.
 *
 * It pays the fee and becomes the change output, so it must cover both. A
 * hundred-input transaction costs well under 1 ADA, and a plain change output
 * needs about 1 ADA to exist.
 */
export const L1_CONSOLIDATION_RESERVE_LOVELACE = 2_000_000n;

/**
 * The most UTxOs one L1 consolidation may hold.
 *
 * The transfer spends nearly every UTxO through mesh's coin selection, which
 * takes no cap, and a body past the 16 KiB maxTxSize fails only in the
 * scheduler. 150 inputs stay well inside it.
 */
export const MAX_L1_CONSOLIDATION_UTXOS = 150;

/**
 * The most distinct native assets the merged output may carry.
 *
 * Every asset lands on one output, bounded by the 5000-byte maxValueSize.
 */
export const MAX_L1_CONSOLIDATION_ASSETS = 40;

/** Below this, the transfer pipeline refuses the amount (see postWalletFundEndpointPost). */
const MIN_TRANSFER_LOVELACE = 2_000_000n;

export type L1ConsolidationUtxo = { amount: ReadonlyArray<{ unit: string; quantity: string }> };

export type L1ConsolidationPlan = {
	lovelaceAmount: bigint;
	assets: Array<{ unit: string; quantity: string }>;
};

/**
 * The self-transfer that merges these UTxOs, or null when there is nothing to
 * merge or too little ADA to pay for merging it. Throws a 400 when the result
 * would be too large for one transaction.
 */
export function planL1Consolidation(utxos: readonly L1ConsolidationUtxo[]): L1ConsolidationPlan | null {
	if (utxos.length < 2) return null;
	if (utxos.length > MAX_L1_CONSOLIDATION_UTXOS) {
		throw createHttpError(
			400,
			`This wallet holds ${utxos.length} UTxOs; one consolidation can merge at most ${MAX_L1_CONSOLIDATION_UTXOS}. Move part of the balance with a transfer first.`,
		);
	}
	const totals = new Map<string, bigint>();
	for (const utxo of utxos) {
		for (const asset of utxo.amount) {
			const unit = asset.unit === '' ? 'lovelace' : asset.unit;
			totals.set(unit, (totals.get(unit) ?? 0n) + BigInt(asset.quantity));
		}
	}
	const lovelaceAmount = (totals.get('lovelace') ?? 0n) - L1_CONSOLIDATION_RESERVE_LOVELACE;
	if (lovelaceAmount < MIN_TRANSFER_LOVELACE) return null;
	const assets = [...totals.entries()]
		.filter(([unit, quantity]) => unit !== 'lovelace' && quantity > 0n)
		.map(([unit, quantity]) => ({ unit, quantity: quantity.toString() }));
	if (assets.length > MAX_L1_CONSOLIDATION_ASSETS) {
		throw createHttpError(
			400,
			`This wallet holds ${assets.length} distinct assets; one output can carry at most ${MAX_L1_CONSOLIDATION_ASSETS}.`,
		);
	}
	return { lovelaceAmount, assets };
}
