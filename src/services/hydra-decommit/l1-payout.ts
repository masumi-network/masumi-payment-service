/**
 * Finding the L1 transaction that paid a withdrawal out.
 *
 * The head tells its node when a withdrawal has settled, and it says what
 * landed — but not which transaction carried it. `DecommitFinalized` reports
 * `distributedUTxO` keyed by the IN-HEAD reference of the output that was
 * removed, which is a reference to a transaction that only ever existed inside
 * the head. Showing that id as the withdrawal's transaction is what made the
 * admin UI look like it linked to a chain explorer and then 404.
 *
 * So the L1 transaction has to be observed rather than read off the event. The
 * search is narrow on purpose: the decrement pays the participant's own address
 * an output whose value the head has already told us exactly, within a couple of
 * blocks of the approval. Matching on that value rather than on timing alone
 * means an unrelated payment arriving in the same block cannot be mistaken for
 * the withdrawal.
 */

import type { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { logger } from '@masumi/payment-core/logger';

/** What the head says landed on L1, as unit to quantity. Lovelace under ''. */
export type DistributedValue = { lovelace: bigint; assets: Record<string, string> };

/**
 * How many pages of address history to walk back.
 *
 * The decrement lands within a block or two of the approval, so one page is
 * almost always enough. The second exists for the case where the node was down
 * across the settlement and other payments have landed since.
 */
const MAX_PAGES = 2;
const PAGE_SIZE = 20;

/** Native assets only, keyed by lower-cased unit, with lovelace pulled out. */
function normalizeAssets(amount: ReadonlyArray<{ unit: string; quantity: string }>): {
	lovelace: bigint;
	assets: Map<string, bigint>;
} {
	let lovelace = 0n;
	const assets = new Map<string, bigint>();
	for (const entry of amount) {
		if (entry.unit === '' || entry.unit.toLowerCase() === 'lovelace') {
			lovelace += BigInt(entry.quantity);
			continue;
		}
		const unit = entry.unit.toLowerCase();
		assets.set(unit, (assets.get(unit) ?? 0n) + BigInt(entry.quantity));
	}
	return { lovelace, assets };
}

function valuesMatch(
	outputAmount: ReadonlyArray<{ unit: string; quantity: string }>,
	expected: DistributedValue,
): boolean {
	const seen = normalizeAssets(outputAmount);
	if (seen.lovelace !== expected.lovelace) return false;

	// Both sides lower-cased through the same function, so a unit that differs
	// only in hex casing still matches — and, more importantly, a mismatch here
	// is a real mismatch rather than an artefact of how one side spelled it.
	const wanted = normalizeAssets(
		Object.entries(expected.assets).map(([unit, quantity]) => ({ unit, quantity })),
	).assets;

	// Exact, not a superset: a decrement output carries precisely what left the
	// head, so an output holding the same token plus something else is a
	// different payment that happens to involve the same asset.
	if (seen.assets.size !== wanted.size) return false;
	for (const [unit, quantity] of wanted) {
		if (seen.assets.get(unit) !== quantity) return false;
	}
	return true;
}

/**
 * The transaction that paid `expected` to `address`, or null if it is not on
 * chain yet.
 *
 * Null rather than throwing: a withdrawal whose L1 transaction has not been seen
 * is still a settled withdrawal, and the admin UI would rather say "settled,
 * transaction not identified" than lose the settlement itself.
 */
export async function findDecommitPayoutTx(params: {
	blockfrost: BlockFrostAPI;
	address: string;
	expected: DistributedValue;
}): Promise<string | null> {
	const { blockfrost, address, expected } = params;

	for (let page = 1; page <= MAX_PAGES; page++) {
		let history: Array<{ tx_hash: string }>;
		try {
			history = await blockfrost.addressesTransactions(address, { page, count: PAGE_SIZE, order: 'desc' });
		} catch (error) {
			logger.warn(`[HydraDecommit] could not read address history while identifying a payout: ${String(error)}`);
			return null;
		}
		if (history.length === 0) return null;

		for (const entry of history) {
			try {
				const utxos = await blockfrost.txsUtxos(entry.tx_hash);
				const match = utxos.outputs.some(
					(output) => output.address === address && valuesMatch(output.amount, expected),
				);
				if (match) return entry.tx_hash;
			} catch (error) {
				// One unreadable transaction is not a reason to abandon the search.
				logger.warn(`[HydraDecommit] could not read ${entry.tx_hash} while identifying a payout: ${String(error)}`);
			}
		}
	}
	return null;
}
