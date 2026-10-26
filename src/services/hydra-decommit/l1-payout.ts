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
 * search is narrow on purpose: the decrement moves this head's state token,
 * leaves the head Open and pays the participant's own address an output whose
 * value the head has already told us exactly. Value and timing alone cannot
 * distinguish an unrelated payment of the same amount.
 */

import type { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { Address, RedeemerTagKind, Transaction } from '@emurgo/cardano-serialization-lib-nodejs';
import { resolveTxHash } from '@meshsdk/core';
import { logger } from '@masumi/payment-core/logger';
import {
	HYDRA_HEAD_V2_ASSET_NAME_HEX,
	hasOpenHydraHeadStateTransition,
	knownHydraHeadScriptHashes,
} from '@/lib/hydra/hydra/head-init-validation';

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
/** Hydra HeadState.Input: Increment = 0, Decrement = 1. */
const HYDRA_DECREMENT_REDEEMER_CONSTRUCTOR = 1n;

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

type IndexedTransaction = Awaited<ReturnType<BlockFrostAPI['txsUtxos']>>;

/** Match this head's indexed state input to its actual L1 spending redeemer. */
function isDecrementOfHead(cbor: string, txHash: string, utxos: IndexedTransaction, headId: string): boolean {
	if (utxos.hash.toLowerCase() !== txHash.toLowerCase()) return false;
	let transaction: Transaction;
	try {
		transaction = Transaction.from_hex(cbor);
		if (!transaction.is_valid() || String(resolveTxHash(cbor)).toLowerCase() !== txHash.toLowerCase()) return false;
	} catch {
		return false;
	}
	const stateUnit = `${headId.toLowerCase()}${HYDRA_HEAD_V2_ASSET_NAME_HEX}`;
	const acceptedHashes = knownHydraHeadScriptHashes();
	const headInputs = utxos.inputs.filter((input) => {
		if (input.collateral || input.reference) return false;
		try {
			const hash = Address.from_bech32(input.address).payment_cred()?.to_scripthash()?.to_hex().toLowerCase();
			return (
				acceptedHashes.has(hash ?? '') &&
				input.amount.some(({ unit, quantity }) => unit.toLowerCase() === stateUnit && quantity === '1')
			);
		} catch {
			return false;
		}
	});
	if (headInputs.length !== 1) return false;
	const headInput = headInputs[0];
	const bodyInputs = transaction.body().inputs();
	let inputIndex = -1;
	for (let index = 0; index < bodyInputs.len(); index++) {
		const input = bodyInputs.get(index);
		if (
			input.transaction_id().to_hex().toLowerCase() === headInput.tx_hash.toLowerCase() &&
			input.index() === headInput.output_index
		) {
			inputIndex = index;
			break;
		}
	}
	if (inputIndex < 0) return false;
	const redeemers = transaction.witness_set().redeemers();
	if (!redeemers) return false;
	for (let index = 0; index < redeemers.len(); index++) {
		const redeemer = redeemers.get(index);
		if (redeemer.tag().kind() !== RedeemerTagKind.Spend || BigInt(redeemer.index().to_str()) !== BigInt(inputIndex)) {
			continue;
		}
		const input = redeemer.data().as_constr_plutus_data();
		return input !== undefined && BigInt(input.alternative().to_str()) === HYDRA_DECREMENT_REDEEMER_CONSTRUCTOR;
	}
	return false;
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
 * can land minutes apart. `notBefore` discards history through the whole block
 * second containing this withdrawal's creation, and `exclude` discards hashes already attributed
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
	headId: string;
	address: string;
	expected: DistributedValue;
	notBefore?: Date;
	exclude?: ReadonlySet<string>;
}): Promise<string | null> {
	const { blockfrost, headId, address, expected, notBefore, exclude } = params;
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
			// Blockfrost reports whole-second slot times. A previous decrement can be
			// observed and a new withdrawal created within that same second; admitting
			// the equal slot would let the previous payout win the oldest-match rule.
			// An equal-second candidate might be genuine, but this timestamp cannot
			// distinguish it from the prior payout. Leave the link unknown instead.
			if (notBeforeSeconds !== undefined && entry.block_time <= notBeforeSeconds) continue;
			try {
				const utxos = await blockfrost.txsUtxos(entry.tx_hash);
				// An exact-value transfer to this wallet is insufficient. A decrement
				// spends this head's official state output and leaves a new Open one.
				if (!hasOpenHydraHeadStateTransition(utxos, headId)) continue;
				const match = utxos.outputs.some(
					(output) => output.address === address && valuesMatch(output.amount, expected),
				);
				if (!match) continue;
				const { cbor } = await blockfrost.txsCbor(entry.tx_hash);
				if (!isDecrementOfHead(cbor, entry.tx_hash, utxos, headId)) continue;
				if (oldestMatch === null || entry.block_time < oldestMatch.block_time) {
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
