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

/** The withdrawal row fields the search bound is taken from. */
export interface DecommitPayoutBoundsRow {
	createdAt: Date;
	/**
	 * Present in the row shape, but deliberately unused below — see
	 * `decommitPayoutSearchBounds`. Kept here so a row can be passed straight
	 * through without a caller stripping it first.
	 */
	approvedAt: Date | null;
}

/** The lower time bound and the hashes to skip for one withdrawal's payout search. */
export interface DecommitPayoutBounds {
	notBefore: Date;
	exclude: Set<string>;
}

/**
 * The search bounds for one withdrawal's payout: how far back to look, and
 * which hashes are already spoken for.
 *
 * The bound is always `createdAt`, never `approvedAt`. It looks safer to bound
 * from the approval — the decrement pays out only after the head approves it,
 * so nothing genuine should land before that — but `approvedAt` is backfilled
 * to "now" at finalization whenever the row's own Approved event was never
 * observed (a restart, a replay starting mid-history, a missed frame; see
 * `applyDecommitOutcome`/`finalizeDecommit`). A backfilled timestamp lands
 * AFTER the payout it is meant to bound, which would exclude the genuine
 * match on every call — including the retry pass — and leave `l1TxId` null
 * forever. `createdAt` is written once, before the decommit transaction is
 * even built, so it is always earlier than the payout that follows it. It
 * still separates two identical-value withdrawals of the same head, because a
 * head has only one withdrawal in flight at a time (the pending-decommit
 * guard plus the in-flight claim in `execute.ts`): row N+1 is created only
 * after row N has finalized.
 *
 * Sibling hashes — L1 transactions already attributed to another withdrawal
 * of the same head — are excluded outright, `null` ones ignored, so an
 * already-claimed payout is never attributed twice.
 */
export function decommitPayoutSearchBounds(
	row: DecommitPayoutBoundsRow,
	siblingPayouts: ReadonlyArray<{ l1TxId: string | null }>,
): DecommitPayoutBounds {
	return {
		notBefore: row.createdAt,
		exclude: new Set(
			siblingPayouts.map((sibling) => sibling.l1TxId).filter((l1TxId): l1TxId is string => l1TxId !== null),
		),
	};
}

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
 *
 * `notBefore` and `exclude` exist because several identical-amount withdrawals
 * can land minutes apart: matching on value alone, as above, would happily
 * return someone else's payout. `notBefore` discards history from before this
 * withdrawal's own creation, and `exclude` discards hashes already attributed
 * to another row. Among what is left, the OLDEST match wins — the payout
 * closest after creation — not the newest, which is what an unbounded
 * newest-first walk would otherwise hand back. That promise holds only while
 * every page loads: a page read failing partway through the walk (below)
 * returns whatever match was already found rather than throwing away a real
 * answer, so what comes back in that case is the best match seen so far, not
 * necessarily the oldest one that exists.
 */
export async function findDecommitPayoutTx(params: {
	blockfrost: BlockFrostAPI;
	address: string;
	expected: DistributedValue;
	notBefore?: Date;
	exclude?: ReadonlySet<string>;
}): Promise<string | null> {
	const { blockfrost, address, expected, notBefore, exclude } = params;
	const notBeforeSeconds = notBefore ? Math.floor(notBefore.getTime() / 1000) : undefined;

	let oldestMatch: { tx_hash: string; block_time: number } | null = null;

	for (let page = 1; page <= MAX_PAGES; page++) {
		let history: Array<{ tx_hash: string; block_time: number }>;
		try {
			history = await blockfrost.addressesTransactions(address, { page, count: PAGE_SIZE, order: 'desc' });
		} catch (error) {
			logger.warn(`[HydraDecommit] could not read address history while identifying a payout: ${String(error)}`);
			break;
		}
		if (history.length === 0) break;

		for (const entry of history) {
			if (exclude?.has(entry.tx_hash)) continue;
			if (notBeforeSeconds !== undefined && entry.block_time < notBeforeSeconds) continue;
			try {
				const utxos = await blockfrost.txsUtxos(entry.tx_hash);
				const match = utxos.outputs.some(
					(output) => output.address === address && valuesMatch(output.amount, expected),
				);
				if (match && (oldestMatch === null || entry.block_time < oldestMatch.block_time)) {
					oldestMatch = entry;
				}
			} catch (error) {
				// One unreadable transaction is not a reason to abandon the search.
				logger.warn(`[HydraDecommit] could not read ${entry.tx_hash} while identifying a payout: ${String(error)}`);
			}
		}
	}
	return oldestMatch?.tx_hash ?? null;
}
