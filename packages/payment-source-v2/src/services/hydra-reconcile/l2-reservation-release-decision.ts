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
 */
export type L2ReservationReleaseDecision =
	| { action: 'hold' }
	| { action: 'baseline'; snapshotNumber: bigint }
	| { action: 'release' };

export function decideL2ReservationRelease(params: {
	inputRefs: readonly string[];
	snapshotNumber: bigint;
	/** The node's own confirmed snapshot number, read after expiry, if recorded. */
	baselineSnapshotNumber: bigint | undefined;
	/** Null when the output is spent, partitioned, or the snapshot is not the verified one. */
	readVerifiedOutput: (reference: string, snapshotNumber: bigint) => string | null;
}): L2ReservationReleaseDecision {
	const { inputRefs, snapshotNumber, baselineSnapshotNumber, readVerifiedOutput } = params;
	// Reservations made before inputs were recorded cannot be proven dead.
	if (inputRefs.length === 0) return { action: 'hold' };
	if (!inputRefs.every((reference) => readVerifiedOutput(reference, snapshotNumber) !== null)) {
		return { action: 'hold' };
	}
	if (baselineSnapshotNumber === undefined) return { action: 'baseline', snapshotNumber };
	if (snapshotNumber <= baselineSnapshotNumber) return { action: 'hold' };
	return { action: 'release' };
}
