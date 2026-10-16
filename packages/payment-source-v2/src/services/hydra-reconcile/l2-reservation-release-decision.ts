/**
 * When an expired, unconfirmed L2 lock reservation is provably dead.
 *
 * Applying a body consumes its inputs, and a spent output never reappears. So
 * the body never applied up to a verified snapshot that still holds every one
 * of its inputs. What that alone cannot exclude is a later snapshot our node
 * signed before expiry and the peer withheld. Hydra snapshots are sequential:
 * our node signs N+1 only after N is confirmed, and an honest node validates
 * requested bodies against its current chain time.
 *
 * The baseline is therefore the node's OWN confirmed number, read from the node
 * after expiry (never a replayed or persisted copy, which can lag). Our node
 * can have signed at most baseline+1 while the body was still valid. A verified
 * snapshot newer than the baseline includes that one, so if it still holds
 * every input, no snapshot has applied the body and none ever will.
 *
 * Assumes our node keeps its signing state: a node that lost persistence could
 * sign a second, different snapshot under an already-used number.
 *
 * The caller passes in only reservations whose expiry the head clock has
 * already passed (`canReportExpiredL2Reservation`).
 *
 * An idle head never confirms that newer snapshot on its own, and the wallet
 * this reservation pins is what our side would need to make one. So
 * `await-snapshot` asks the caller to nudge the head with a self-send of an
 * unreserved wallet UTxO (`./l2-reservation-nudge`). Once a nudge input is
 * recorded, release also waits until that input is spent: freeing the wallet
 * while the nudge is still in flight would let a new lock select its input.
 */
export type L2ReservationReleaseDecision =
	| { action: 'hold' }
	| { action: 'baseline'; snapshotNumber: bigint }
	| { action: 'await-snapshot' }
	| { action: 'release' };

export function decideL2ReservationRelease(params: {
	inputRefs: readonly string[];
	snapshotNumber: bigint;
	/** The node's own confirmed snapshot number, read after expiry, if recorded. */
	baselineSnapshotNumber: bigint | undefined;
	/** The wallet UTxO a release nudge spends, once one was recorded. */
	nudgeInputRef: string | null;
	/** Null when the output is spent, partitioned, or the snapshot is not the verified one. */
	readVerifiedOutput: (reference: string, snapshotNumber: bigint) => string | null;
	/** True when the verified snapshot holds the output as a deposit still being folded in. */
	isPendingCommit?: (reference: string, snapshotNumber: bigint) => boolean;
}): L2ReservationReleaseDecision {
	const { inputRefs, snapshotNumber, baselineSnapshotNumber, nudgeInputRef, readVerifiedOutput } = params;
	const isPendingCommit = params.isPendingCommit ?? (() => false);
	// Reservations made before inputs were recorded cannot be proven dead.
	if (inputRefs.length === 0) return { action: 'hold' };
	const unreadable = inputRefs.filter((reference) => readVerifiedOutput(reference, snapshotNumber) === null);
	if (unreadable.length > 0) {
		// A pending commit proves nothing either way. After CommitFinalized the
		// node's local ledger already holds it, so a body may have spent it there;
		// only the next signed snapshot shows which. An idle head never makes that
		// snapshot without a nudge, so ask for one. This branch must never release:
		// the next snapshot shows the input spent (hold) or spendable (baseline).
		// While the deposit stays unobserved on L1 this repeats once per nudge
		// interval, and it ends when the head folds the deposit in or recovers it.
		const onlyPendingCommits = unreadable.every((reference) => isPendingCommit(reference, snapshotNumber));
		return onlyPendingCommits ? { action: 'await-snapshot' } : { action: 'hold' };
	}
	if (baselineSnapshotNumber === undefined) return { action: 'baseline', snapshotNumber };
	if (snapshotNumber <= baselineSnapshotNumber) return { action: 'await-snapshot' };
	if (nudgeInputRef !== null && readVerifiedOutput(nudgeInputRef, snapshotNumber) !== null) {
		return { action: 'await-snapshot' };
	}
	return { action: 'release' };
}
