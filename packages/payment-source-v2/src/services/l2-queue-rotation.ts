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

import { logger } from '@masumi/payment-core/logger';

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
 * How far the stand-down may grow, and how many attempts a request gets.
 *
 * A flat cooldown is right for a transient condition and wrong for a permanent
 * one. The pass had no terminal path at all: a request whose failure can never
 * clear — a body the head deterministically refuses, a `hydraHeadId` that is
 * not on the transaction, a head latched closing — was re-picked every minute
 * forever, decrypting a mnemonic and signing a body each time, while its escrow
 * quietly ran out its deadline and never reached the manual-action queue an
 * operator actually reads.
 *
 * So the stand-down doubles, and after `MAX_L2_ATTEMPTS` of them the caller is
 * told to give up and park the request for a human. Twelve attempts across a
 * doubling schedule capped at half an hour is a little over three hours, which
 * is long enough that no transient head condition is mistaken for a permanent
 * one.
 */
export const MAX_L2_DEFERRAL_COOLDOWN_MS = 30 * 60_000;
export const MAX_L2_ATTEMPTS = 12;

/**
 * A stand-down is a hint, so it is bounded rather than allowed to accumulate.
 * Reached only if thousands of distinct requests defer inside one minute, in
 * which case the oldest hints are the least useful ones to keep.
 */
const MAX_TRACKED_DEFERRALS = 5_000;

/** Request id -> the moment its stand-down ends. */
const deferredUntilMs = new Map<string, number>();
/** Request id -> how many times it has stood down without progressing. */
const attempts = new Map<string, number>();

function prune(now: number): void {
	for (const [requestId, until] of deferredUntilMs) {
		if (until <= now) {
			deferredUntilMs.delete(requestId);
		}
	}
	// Attempt counts outlive the stand-down they caused — that is the point, a
	// request that fails once a minute has to be recognised as failing — but they
	// must not outlive the process's interest in the request. Bounded by the same
	// ceiling, and cleared outright by `clearL2RequestAttempts` on progress.
	if (attempts.size > MAX_TRACKED_DEFERRALS) {
		const oldest = attempts.keys().next();
		if (oldest.done !== true) attempts.delete(oldest.value);
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
	const attempt = (attempts.get(requestId) ?? 0) + 1;
	attempts.set(requestId, attempt);
	const backoff = Math.min(L2_DEFERRAL_COOLDOWN_MS * 2 ** (attempt - 1), MAX_L2_DEFERRAL_COOLDOWN_MS);
	deferredUntilMs.set(requestId, now + backoff);
}

/**
 * Whether this request has stood down often enough to be treated as stuck.
 *
 * Read after `markL2RequestDeferred`, so the attempt just made is counted.
 */
export function hasExhaustedL2Attempts(requestId: string): boolean {
	return (attempts.get(requestId) ?? 0) >= MAX_L2_ATTEMPTS;
}

/**
 * What a request parked for making no progress records as its error.
 *
 * The rollback path has no error to carry — the pass returned false rather than
 * throwing — so the note has to say that itself, or an operator opening the
 * request finds `WaitingForManualAction` with nothing explaining it.
 */
export const NO_PROGRESS_NOTE = 'the in-head pass rolled back on every attempt';

/**
 * Stand a request down, and hand it to an operator once it has run out of them.
 *
 * `park` is the calling service's own failure marker, which moves the request
 * to `WaitingForManualAction` with the interpreted error on it. It is passed in
 * rather than done here because each service records its own error note, and
 * because payments and purchases park through different writers.
 *
 * The park is allowed to fail. Every caller's next statement is the wallet
 * unlock, and that has to run whatever happens here: a request that is not
 * parked is simply retried, while a wallet left locked stops every request on
 * it. A failed park also keeps the attempt count at its ceiling, so the next
 * stand-down tries again rather than starting the count over.
 */
export async function standDownL2Request(requestId: string, park: () => Promise<void>): Promise<void> {
	markL2RequestDeferred(requestId);
	if (!hasExhaustedL2Attempts(requestId)) return;
	try {
		await park();
		clearL2RequestAttempts(requestId);
	} catch (error) {
		logger.error('Failed to park an exhausted L2 request', { requestId, error });
	}
}

/** Forget a request's history once it has progressed. */
export function clearL2RequestAttempts(requestId: string): void {
	attempts.delete(requestId);
	deferredUntilMs.delete(requestId);
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
	attempts.clear();
}
