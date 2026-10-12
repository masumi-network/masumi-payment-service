import { getOwnPlainObject, getOwnValue, isPlainObject } from '@masumi/payment-core/object-properties';

/**
 * Output refs the head has approved to commit but not yet finalized.
 *
 * After CommitApproved the confirmed snapshot lists the deposit under
 * `utxoToCommit`, and `/snapshot/utxo` already shows it. The ledger takes it
 * only once the increment tx is observed on L1 (CommitFinalized): until then any
 * transaction that spends it fails with "All inputs are spent". The snapshot
 * keeps `utxoToCommit` after finalization, so the version pair decides: the
 * head's version moves past the snapshot's once the increment is observed.
 *
 * An unreadable state with no deposit in progress is treated as finalized, the
 * same fail-open choice `extractPendingDecommitRefs` makes: the worst case is one
 * failed spend, never a wallet blocked in the head for good.
 */
export function extractPendingCommitRefs(headState: unknown): string[] {
	if (!isPlainObject(headState)) return [];
	const state = getOwnPlainObject(headState, 'contents') ?? headState;
	const coordinatedHeadState = getOwnPlainObject(state, 'coordinatedHeadState');
	if (coordinatedHeadState === undefined) return [];
	const snapshot = getOwnPlainObject(getOwnPlainObject(coordinatedHeadState, 'confirmedSnapshot') ?? {}, 'snapshot');
	if (snapshot === undefined) return [];
	const utxoToCommit = getOwnPlainObject(snapshot, 'utxoToCommit');
	if (utxoToCommit === undefined) return [];

	const version = getOwnValue(coordinatedHeadState, 'version');
	const snapshotVersion = getOwnValue(snapshot, 'version');
	// A deposit in progress says nothing about this `utxoToCommit` when the versions are readable: it can be
	// the stale, finalized set of an earlier deposit while the next one waits for approval.
	const isPending =
		typeof version === 'number' && typeof snapshotVersion === 'number'
			? version <= snapshotVersion
			: typeof getOwnValue(coordinatedHeadState, 'currentDepositTxId') === 'string';
	if (!isPending) return [];
	return Object.keys(utxoToCommit).map((key) => key.toLowerCase());
}

/** Reads `/head`. Throws when the node cannot answer, so callers fail closed. */
export async function fetchPendingCommitRefs(node: { get<T = unknown>(url: string): Promise<T> }): Promise<string[]> {
	return extractPendingCommitRefs(await node.get('/head'));
}
