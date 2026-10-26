/**
 * Which decommit transactions a snapshot transition has to be given.
 *
 * A decommit is a real transaction that Hydra reports outside the `confirmed`
 * list — it appears as the snapshot's `utxoToDecommit` partition — so the
 * conservation walk has to be handed it explicitly or a legitimate withdrawal
 * looks like value vanishing for no reason.
 *
 * Exactly once, though, and that is what this decides. The decommit stays
 * pending until its L1 decrement settles, which takes minutes, so every
 * snapshot signed in between carries the same partition. Supplying the
 * transaction again on each of them hands the walk a transaction that has
 * already been applied: its inputs are no longer in the previous state, so they
 * count as external with nothing to consume against, and the transition is
 * rejected. That rejection is not local — it fails the entire history, so no
 * live session forms and every L2 escrow operation fails closed against a head
 * that is up and Open.
 */

import type { DecommitSettledData, HydraTransaction } from './types';

/**
 * The transactions behind the decommits this transition declares for the first
 * time.
 *
 * `previousOutputs` is the previous snapshot's canonical reference set, which
 * spans `utxo ∪ utxoToCommit ∪ utxoToDecommit` — so a reference already in it
 * was declared before this transition and has been accounted for already.
 *
 * A transaction whose outputs are partly new counts as new: a single decommit
 * cannot straddle two snapshots that way, and treating it as new is the
 * conservative direction, since the walk then has the transaction rather than a
 * gap it cannot explain.
 */
export function resolveNewlyDeclaredDecommitTransactions(
	/** The `tx-id#index` keys of the current snapshot's `utxoToDecommit`. */
	references: readonly string[],
	previousOutputs: ReadonlyMap<string, string>,
	lookup: (txId: string) => HydraTransaction | undefined,
): HydraTransaction[] {
	/** Transaction id to "every one of its references was already declared". */
	const declaredBefore = new Map<string, boolean>();
	for (const reference of references) {
		const canonical = reference.toLowerCase();
		const separator = canonical.indexOf('#');
		if (separator <= 0) continue;
		const txId = canonical.slice(0, separator);
		const isOld = previousOutputs.has(canonical);
		declaredBefore.set(txId, (declaredBefore.get(txId) ?? true) && isOld);
	}

	const resolved: HydraTransaction[] = [];
	for (const [txId, wasDeclaredBefore] of declaredBefore) {
		if (wasDeclaredBefore) continue;
		const transaction = lookup(txId);
		if (transaction) resolved.push(transaction);
	}
	return resolved;
}

/**
 * How many decommit transactions to keep for transition checking.
 *
 * Only one can be pending at a time, so this is generous by design: it exists
 * so a long history cannot grow the map without bound.
 */
export const MAX_TRACKED_DECOMMIT_TRANSACTIONS = 64;

/** Keep a requested decommit for the `lookup` above, keyed by its lower-case tx id. */
export function rememberDecommitTransaction(
	tracked: Map<string, HydraTransaction>,
	transaction: HydraTransaction,
): void {
	const txId = transaction.txId?.toLowerCase();
	if (!txId) return;
	if (tracked.has(txId)) return;
	// Narrowed to the modelled fields, not stored verbatim. `hydraTransactionSchema`
	// is deliberately loose so a field a newer node adds cannot wedge replay, and
	// this map's only bound is an entry count — 64 frames each just under the 4 MiB
	// frame limit because of one unmodelled field retain ~256 MiB per node, four
	// times the whole configured CBOR budget, and nothing clears the map on
	// disconnect. Only `txId` and `cborHex` are ever read back off these entries.
	tracked.set(txId, {
		type: transaction.type,
		cborHex: transaction.cborHex,
		description: transaction.description,
		txId: transaction.txId,
	});
	if (tracked.size > MAX_TRACKED_DECOMMIT_TRANSACTIONS) {
		const oldest = tracked.keys().next().value;
		if (oldest !== undefined) tracked.delete(oldest);
	}
}

/** One ordered socket/pass owns this cursor; never share it between live and replay. */
export type DecommitOutcomeCursor = { approval?: DecommitSettledData | null };

/**
 * Hydra 2.4.1 finalizations omit the decommit id. Their distributedUTxO keys
 * come from the L1 decrement inputs (Hydra.Tx.Decrement.observeDecrementTx),
 * so they cannot supply it either. Only the preceding approval in this same
 * ordered stream identifies the withdrawal. A fresh stream starts empty.
 */
export function correlateDecommitOutcome(
	cursor: DecommitOutcomeCursor,
	data: DecommitSettledData,
): DecommitSettledData | undefined {
	if (data.outcome === 'approved') {
		// Different approvals without a finalization make the stream ambiguous.
		cursor.approval =
			cursor.approval === undefined || cursor.approval?.decommitTxId === data.decommitTxId ? data : null;
		return data;
	}
	if (data.outcome !== 'finalized') return data;
	const approval = cursor.approval;
	if (data.decommitTxId != null && approval != null && data.decommitTxId !== approval.decommitTxId) {
		return undefined;
	}
	if (data.observedAt && approval?.observedAt && data.observedAt < approval.observedAt) return undefined;
	const decommitTxId = data.decommitTxId ?? approval?.decommitTxId;
	cursor.approval = undefined;
	// An uncorrelated finalization may be the peer's. Never attribute it by age.
	return decommitTxId == null ? undefined : { ...data, decommitTxId };
}
