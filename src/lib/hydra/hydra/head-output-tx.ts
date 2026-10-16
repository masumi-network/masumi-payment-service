/**
 * Which L1 transaction produced the head's current state output.
 *
 * `HeadIsClosed` carries `headId`, `snapshotNumber` and `contestationDeadline`
 * and no transaction id, so the frame cannot tell us how the head was closed.
 * The node does know: `GET /head` returns the head state including its
 * `chainState`, and a `spendableUTxO` map is keyed by `txId#index`. The head's
 * own output in that map is the output the last head transaction produced — so
 * at the moment the head reaches `Closed`, before any fanout step, that key's
 * transaction id IS the close transaction.
 *
 * Read from the node rather than discovered on L1 deliberately. This is the
 * node's own observed chain state, so there is no independent lookup to
 * correlate, no confirmation depth to wait for, and no question of matching the
 * wrong transaction. The head output is identified the same way hydra-node
 * identifies it internally — by the head's own currency symbol, which is minted
 * one-shot from the seed input and therefore cannot be forged by an output
 * someone else pays to the same script address.
 *
 * TIMING MATTERS. Partial fanout spends the head output and produces a new one,
 * so after the first fanout step this returns that step's transaction, not the
 * close. Capture it on the transition into `Closed` and never re-derive it
 * afterwards.
 */

import { logger } from '@masumi/payment-core/logger';
import { getOwnPlainObject, getOwnValue, isPlainObject } from '@masumi/payment-core/object-properties';

/**
 * `txId#index`, as hydra keys a UTxO map.
 *
 * The index is bounded to what a uint32 can express, matching
 * `hydraSnapshotOutputReferenceSchema`. Only the transaction id is read, so a
 * longer index would be harmless — but accepting a shape the rest of the
 * codebase rejects is how two parsers of the same string drift apart.
 */
const OUTPUT_REFERENCE = /^([0-9a-fA-F]{64})#([0-9]{1,10})$/;

/**
 * Bound the scan over another process's JSON.
 *
 * Arbitrary, and far above anything real: the head's spendable set is the head
 * output and little else. It exists so a malformed or hostile payload cannot
 * make this walk forever, not because a legitimate head approaches it — which
 * is why reaching it is logged rather than treated as "not found".
 */
const MAX_SCANNED_OUTPUTS = 5_000;

/**
 * True when this output carries an asset under the head's currency symbol.
 *
 * The head identifier IS the minting policy id of the head's state token, so
 * holding one is what makes an output the head's rather than merely an output
 * someone sent to the same script address.
 */
function carriesHeadToken(output: object, headIdentifier: string): boolean {
	const value = getOwnPlainObject(output, 'value');
	if (value === undefined) return false;
	// Matched case-insensitively rather than by exact key. Our side of the
	// comparison is normalised by canonicalHydraHeadIdSchema, but the key comes
	// from the node's JSON, and a mismatch there would not fail loudly — it would
	// silently report the head output as absent.
	const policy = Object.keys(value).find((key) => key.toLowerCase() === headIdentifier);
	if (policy === undefined) return false;
	const assets = getOwnValue(value, policy);
	// A policy entry is an object of assetName -> quantity. Anything else (a bare
	// number under a 56-hex key) is not a policy bucket and does not count.
	return isPlainObject(assets) && Object.keys(assets).length > 0;
}

/**
 * The transaction id that produced the head's state output, or undefined.
 *
 * Undefined rather than throwing for every "cannot tell" case: this feeds an
 * informational column, and a head whose close transaction cannot be named must
 * still close.
 */
export function extractHeadOutputTxId(headState: unknown, headIdentifier: string): string | undefined {
	if (!isPlainObject(headState)) return undefined;
	if (!/^[0-9a-fA-F]{56}$/.test(headIdentifier)) return undefined;
	const wanted = headIdentifier.toLowerCase();

	// hydra-node's real `GET /head` reply nests chainState under `contents`
	// (`{ tag, contents: { chainState, ... } }`); a flat `{ tag, chainState }` is
	// accepted too so either shape works.
	const state = getOwnPlainObject(headState, 'contents') ?? headState;
	const chainState = getOwnPlainObject(state, 'chainState');
	if (chainState === undefined) return undefined;
	const spendable = getOwnPlainObject(chainState, 'spendableUTxO');
	if (spendable === undefined) return undefined;

	// Collected rather than returned on the first hit. hydra-node identifies the
	// head output by currency symbol AND by it being the head validator's script
	// output; we can only see the symbol here, and participation tokens are
	// minted under that same symbol. If more than one output carries it we cannot
	// tell which is the state output, and naming the wrong transaction is worse
	// than naming none — this is an informational field.
	const producers = new Set<string>();
	let scanned = 0;
	for (const reference of Object.keys(spendable)) {
		if (++scanned > MAX_SCANNED_OUTPUTS) {
			// Distinguished from "not found" in the log, because the two mean very
			// different things and the return value cannot tell them apart.
			logger.warn('[HydraNode] Gave up scanning the head state for its output transaction', {
				headIdentifier: wanted,
				scanned: MAX_SCANNED_OUTPUTS,
			});
			return undefined;
		}
		const match = OUTPUT_REFERENCE.exec(reference);
		if (match === null) continue;
		if (Number(match[2]) > 0xffff_ffff) continue;
		const output = getOwnValue(spendable, reference);
		if (!isPlainObject(output)) continue;
		if (!carriesHeadToken(output, wanted)) continue;
		producers.add(match[1].toLowerCase());
		if (producers.size > 1) return undefined;
	}

	return producers.size === 1 ? [...producers][0] : undefined;
}

/**
 * Output references (`txid#ix`, lower-cased) the head's confirmed snapshot is
 * still waiting to decommit onto L1.
 *
 * Hydra produces no new snapshot while `utxoToDecommit` is non-empty — the
 * node's chain follower has not yet observed the previous decommit's
 * DecrementTx. A caller that starts another in-head split while this is
 * non-empty gets a split that is TxValid but can never be snapshot-confirmed.
 * This is the withdrawal-side mirror of `pendingIncrementUtxoRefs` ("still
 * being folded into the head by a deposit"), which guards the opposite
 * direction.
 *
 * But `utxoToDecommit` alone is NOT proof the decommit is still pending: it
 * stays populated in the LAST confirmed snapshot until the head produces a
 * NEW one, and a new snapshot only happens once another transaction arrives —
 * which this guard blocks. Left unchecked that is a deadlock: a finalized
 * decommit reads as "still pending" forever. Two independent signals confirm
 * genuine resolution instead: `coordinatedHeadState.decommitTx` is cleared to
 * `null` once the node stops holding a transaction it must post, AND
 * `coordinatedHeadState.version` has moved past `confirmedSnapshot.snapshot`'s
 * own `version` once the chain has observed that post. Either signal alone
 * still showing "pending" (a held `decommitTx`, or the version not yet past
 * the snapshot) keeps the guard active. Both signals unreadable (no
 * `decommitTx` object AND no numeric version pair — an unrecognised shape)
 * clears the guard instead, logged: the opposite would jam every withdrawal
 * from the head forever rather than for one refused attempt, which is what
 * this guard's own refinement exists to avoid, and it would contradict
 * `fetchHydraPendingDecommitRefs`, which already fails open on a transport
 * error one layer up.
 *
 * `[]` rather than throwing for every "cannot tell" case, exactly like
 * `extractHeadOutputTxId`: this feeds a pre-flight guard, and a head whose
 * state cannot be read must not jam every withdrawal forever.
 */
export function extractPendingDecommitRefs(headState: unknown): string[] {
	if (!isPlainObject(headState)) return [];

	// Same nested-vs-flat shape as extractHeadOutputTxId: hydra-node's real
	// `GET /head` reply nests everything under `contents`.
	const state = getOwnPlainObject(headState, 'contents') ?? headState;
	const coordinatedHeadState = getOwnPlainObject(state, 'coordinatedHeadState');
	if (coordinatedHeadState === undefined) return [];
	const confirmedSnapshot = getOwnPlainObject(coordinatedHeadState, 'confirmedSnapshot');
	if (confirmedSnapshot === undefined) return [];
	const snapshot = getOwnPlainObject(confirmedSnapshot, 'snapshot');
	if (snapshot === undefined) return [];
	const utxoToDecommit = getOwnPlainObject(snapshot, 'utxoToDecommit');
	if (utxoToDecommit === undefined) return [];

	// The node still holds the decommit transaction it must post.
	const decommitTxHeld = isPlainObject(getOwnValue(coordinatedHeadState, 'decommitTx'));
	// The chain has not yet observed that post. Either field missing or not a
	// number cannot prove resolution, so it stays on the "pending" side.
	const version = getOwnValue(coordinatedHeadState, 'version');
	const snapshotVersion = getOwnValue(snapshot, 'version');
	const versionReadable = typeof version === 'number' && typeof snapshotVersion === 'number';
	const chainNotPastSnapshot = versionReadable ? version <= snapshotVersion : true;

	if (!decommitTxHeld && !chainNotPastSnapshot) return [];

	// Both signals unreadable — no decommitTx object AND no numeric version
	// pair — is not the same as "genuinely pending". The fallback above
	// defaults an unreadable version pair to "not past" (fail-closed) so a
	// truly pending decommit is never cleared early, but that same default
	// means this combination can never satisfy the check above on its own: it
	// always needs the version pair to be BOTH readable AND past. Left alone
	// that is not a cautious guard, it is a permanent one — every withdrawal
	// from this head refused forever. Fail open instead, the same way
	// `fetchHydraPendingDecommitRefs` already fails open on a transport error
	// one layer up: worst case one withdrawal is refused or left to retry,
	// never funds actually leaving the head.
	if (!decommitTxHeld && !versionReadable) {
		logger.warn(
			'[HydraNode] Pending-decommit state unreadable (no decommitTx object, no numeric version pair); treating as resolved rather than blocking withdrawals indefinitely',
		);
		return [];
	}

	return Object.keys(utxoToDecommit).map((key) => key.toLowerCase());
}
