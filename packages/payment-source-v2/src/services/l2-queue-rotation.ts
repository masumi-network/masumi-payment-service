/**
 * Rotating a stuck request out of the head of its wallet's L2 queue.
 *
 * The six L2 escrow passes select one request per wallet, oldest first, because
 * a wallet can hold only one durable L2 reservation at a time. That makes the
 * oldest eligible request a head-of-line: as long as it stays eligible, it is
 * chosen on every tick, and everything behind it waits.
 *
 * Which is fine when a failure is transient — the next tick is a retry. It is
 * not fine when a request cannot progress at all: a payment carrying an
 * unresolved terminal hash defers on every single tick, forever, and every
 * other escrow on that wallet waits behind it while its own deadlines pass.
 *
 * The stand-down is held here, in memory, and not written to the request.
 *
 * The obvious place to put it — `sellerCoolDownTime` / `buyerCoolDownTime`,
 * which the selection already honours — is not a scheduler field. Those two
 * columns are the persisted mirror of the *spent datum's* cooldowns, written by
 * the datum sync from the decoded datum and read back by
 * `continuationHasAuthorizedActor` as the floor a continuing action's
 * `invalid_before` must clear. Pushing one forward to skip a tick therefore
 * raises the bar the next signed body has to meet, and the body anchors its
 * lower bound to the datum rather than to us: the guard then cannot be
 * satisfied by any retry, the replay reports `retry` forever, and reconciliation
 * stalls for every escrow in that head — not just this one.
 *
 * Memory is the right lifetime anyway. A stand-down means "not this minute",
 * and a process that restarts inside that minute has already lost the queue it
 * was rotating; the request is simply retried, which is where it started.
 */

/**
 * How long a deferred request stands aside.
 *
 * Long enough that a wallet with several waiting escrows gets through them,
 * short enough that a request deferring on a genuinely transient condition —
 * a head still catching up, a UTxO not yet observed — is retried well inside
 * any escrow deadline.
 */
export const L2_DEFERRAL_COOLDOWN_MS = 60_000;

/**
 * A stand-down is a hint, so it is bounded rather than allowed to accumulate.
 * Reached only if thousands of distinct requests defer inside one minute, in
 * which case the oldest hints are the least useful ones to keep.
 */
const MAX_TRACKED_DEFERRALS = 5_000;

/** Request id -> the moment its stand-down ends. */
const deferredUntilMs = new Map<string, number>();

function prune(now: number): void {
	for (const [requestId, until] of deferredUntilMs) {
		if (until <= now) {
			deferredUntilMs.delete(requestId);
		}
	}
}

/**
 * Stand a request down for one cooldown, so the queue behind it can move.
 *
 * Safe to call from a catch arm: it touches nothing outside this map and cannot
 * throw, so it can never displace the unlock the arm exists to perform.
 */
export function markL2RequestDeferred(requestId: string): void {
	const now = Date.now();
	prune(now);
	if (deferredUntilMs.size >= MAX_TRACKED_DEFERRALS && !deferredUntilMs.has(requestId)) {
		const oldest = deferredUntilMs.keys().next();
		if (oldest.done !== true) {
			deferredUntilMs.delete(oldest.value);
		}
	}
	deferredUntilMs.set(requestId, now + L2_DEFERRAL_COOLDOWN_MS);
}

/**
 * The requests currently standing aside, for the selection to skip.
 *
 * Excluding them is a scheduling choice and nothing more: a skipped request is
 * as eligible as it ever was, and the next pass after its stand-down ends picks
 * it up unchanged.
 */
export function deferredL2RequestIds(): string[] {
	prune(Date.now());
	return [...deferredUntilMs.keys()];
}

/** Test seam: forget every stand-down. */
export function clearL2Deferrals(): void {
	deferredUntilMs.clear();
}
