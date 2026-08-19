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

import type { HydraTransaction } from './types';

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
