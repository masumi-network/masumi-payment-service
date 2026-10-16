/**
 * When a Pending L2 reservation on a Final head is provably dead.
 *
 * A Final head confirms no snapshot after the one it fanned out, and the open
 * head path cannot make one (the nudge needs an open head). So the expiry
 * baseline above never advances there. It is not needed either: the final
 * snapshot is the last state the head will ever have. If it still holds every
 * input of the body as spendable state, the body never applied and never will.
 *
 * The caller reads `readFinalOutput` only after it verified that snapshot's
 * fanout on chain. A reservation with no known inputs, or with any input spent
 * or pending decommit, stays held for an operator.
 */
export function isL2ReservationDeadInFinalSnapshot(params: {
	inputRefs: readonly string[];
	/** Null unless the verified, fanned-out final snapshot holds the output unspent. */
	readFinalOutput: (reference: string) => string | null;
}): boolean {
	return (
		params.inputRefs.length > 0 && params.inputRefs.every((reference) => params.readFinalOutput(reference) !== null)
	);
}
