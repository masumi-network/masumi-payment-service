import { FixedTransaction } from '@emurgo/cardano-serialization-lib-nodejs';
import { logger } from '@masumi/payment-core/logger';

import type { HydraTransaction } from './types';

/**
 * Tokens minted inside the head and not yet burned there.
 *
 * Hydra cannot finalize a head that still holds such a token. The token never
 * entered the head output on L1, so no fanout step that carries it can balance,
 * and the last step has to distribute everything left (Hydra known issues,
 * partial fanout "unburned tokens"). No hydra-node setting forbids L2 minting,
 * and any peer can mint through its own node, so the service cannot prevent
 * it. What it can do is keep its own funds off those UTxOs: an output that
 * carries the token can never leave the head, and spending one beside our
 * funds would carry the token into our change.
 */

/** Units named in one log line; a peer chooses how many units the tally holds. */
const LOGGED_UNIT_SAMPLE = 5;

/** A log-sized description of `units`. */
export function describeUnits(units: Iterable<string>): { count: number; sample: string[] } {
	const all = [...units];
	return { count: all.length, sample: all.slice(0, LOGGED_UNIT_SAMPLE) };
}

/**
 * The transaction that took the head's net L2 mint balance from zero to
 * nonzero, and the units with a nonzero net after its snapshot, each with its
 * signed net (`<unit> +1`). A negative net is a committed L1 token burned in
 * the head; later transactions in the same snapshot may have added units.
 * It stays the same on every replay of the same history, so it names the
 * incident however often it is reported.
 */
export interface L2MintIncident {
	txHash: string;
	snapshotNumber: number;
	netUnits: { count: number; sample: string[] };
}

/** Net L2 mint per unit (zero entries dropped), and the incident behind a nonzero balance. */
export interface L2MintTally {
	units: Map<string, bigint>;
	openedBy?: L2MintIncident;
}

/**
 * What the history replay can vouch for: the units with a positive net L2 mint as of the
 * signed snapshot whose outputs are `verifiedOutputs` (keyed `txid#index`,
 * lowercase). The node's HTTP UTxO view runs ahead of the replay, and a peer
 * can widen that gap, so a token UTxO missing from `verifiedOutputs` comes from
 * a transaction the tally has not seen and counts as unchecked.
 */
export interface L2MintCheck {
	unburnedUnits: ReadonlySet<string>;
	verifiedOutputs: ReadonlyMap<string, string>;
}

/**
 * The check for the replay's current signed state. Snapshot 0 is the node's own
 * unsigned ledger report (a head with no signed snapshot yet, or a node rebuilt
 * from L1): no transaction behind it was tallied, so it vouches for no output.
 */
export function buildL2MintCheck(
	tally: L2MintTally,
	snapshot: { number: number; outputs: ReadonlyMap<string, string> },
): L2MintCheck {
	// A negative net is a committed L1 token burned in the head. What is left of
	// it is still backed by the commit, so only a positive net marks a mint.
	const unburnedUnits = new Set([...tally.units].filter(([, net]) => net > 0n).map(([unit]) => unit));
	return {
		unburnedUnits,
		verifiedOutputs: snapshot.number === 0 ? new Map() : snapshot.outputs,
	};
}

/**
 * Add the mint field of each transaction into `tally.units` (unit → net
 * quantity). A unit whose net reaches zero is dropped, so the keys are exactly
 * the units still outstanding. Sets `tally.openedBy` when one of these
 * transactions took the balance from zero to nonzero and it is still nonzero
 * at the end, and clears it at zero. Logs only when the head starts or stops
 * holding such units: a peer decides how often it mints.
 *
 * Only called on transactions the conservation check has already decoded.
 */
export function recordL2TransactionMints(
	tally: L2MintTally,
	transactions: readonly HydraTransaction[],
	snapshotNumber: number,
): void {
	const units = tally.units;
	const wasOpen = tally.openedBy !== undefined;
	let openingTxHash: string | undefined;
	for (const { cborHex } of transactions) {
		const transaction = FixedTransaction.from_bytes(Buffer.from(cborHex, 'hex'));
		const mint = transaction.body().mint();
		if (!mint) continue;
		const wasClear = units.size === 0;
		// CSL lists a repeated policy key once per entry, and `get` returns every
		// group for it each time, so visit each policy once.
		const seenPolicies = new Set<string>();
		const policies = mint.keys();
		for (let policyIndex = 0; policyIndex < policies.len(); policyIndex += 1) {
			const policy = policies.get(policyIndex);
			if (seenPolicies.has(policy.to_hex())) continue;
			seenPolicies.add(policy.to_hex());
			const groups = mint.get(policy);
			if (!groups) continue;
			for (let groupIndex = 0; groupIndex < groups.len(); groupIndex += 1) {
				const assets = groups.get(groupIndex);
				if (!assets) continue;
				const names = assets.keys();
				for (let assetIndex = 0; assetIndex < names.len(); assetIndex += 1) {
					const name = names.get(assetIndex);
					const quantity = assets.get(name);
					if (!quantity) continue;
					const positive = quantity.as_positive();
					const negative = quantity.as_negative();
					const signed = positive ? BigInt(positive.to_str()) : negative ? -BigInt(negative.to_str()) : 0n;
					// `.name()`, not `.to_hex()`: the latter CBOR-wraps the asset name.
					const unit = `${policy.to_hex()}${Buffer.from(name.name()).toString('hex')}`.toLowerCase();
					const net = (units.get(unit) ?? 0n) + signed;
					if (net === 0n) units.delete(unit);
					else units.set(unit, net);
				}
			}
		}
		if (wasClear && units.size > 0) openingTxHash = transaction.transaction_hash().to_hex().toLowerCase();
	}
	if (units.size === 0) {
		tally.openedBy = undefined;
		if (wasOpen) logger.info('[HydraNode] The head L2 mint balance is back to zero', { snapshotNumber });
		return;
	}
	if (openingTxHash === undefined) return;
	const netUnits = describeUnits([...units].map(([unit, net]) => `${unit} ${net > 0n ? '+' : ''}${net}`));
	tally.openedBy = { txHash: openingTxHash, snapshotNumber, netUnits };
	logger.error(
		'[HydraNode] The head net L2 mint balance left zero; a token minted in it and not burned blocks finalization',
		tally.openedBy,
	);
}

/**
 * Why our own transactions must leave this UTxO unspent, or null when they may
 * spend it. A UTxO with only ADA is always safe. One with any other asset is
 * `minted` when it holds an unburned unit, and `unchecked` when the replay has
 * not finished (`check` undefined) or has not reached the snapshot that made it.
 */
export function l2TokenRisk(
	utxo: { input: { txHash: string; outputIndex: number }; output: { amount: ReadonlyArray<{ unit: string }> } },
	check: L2MintCheck | undefined,
): 'unchecked' | 'minted' | null {
	const tokenUnits = utxo.output.amount
		.map((asset) => asset.unit.toLowerCase())
		.filter((unit) => unit !== '' && unit !== 'lovelace');
	if (tokenUnits.length === 0) return null;
	if (check === undefined) return 'unchecked';
	if (!check.verifiedOutputs.has(`${utxo.input.txHash}#${utxo.input.outputIndex}`.toLowerCase())) return 'unchecked';
	return tokenUnits.some((unit) => check.unburnedUnits.has(unit)) ? 'minted' : null;
}
