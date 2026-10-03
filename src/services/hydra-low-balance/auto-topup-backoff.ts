import { HydraTopupStatus } from '@/generated/prisma/client';

/**
 * How long a rule waits after its own top-ups have started failing.
 *
 * The auto top-up cycle runs every thirty seconds and its only brake is an
 * in-flight deposit. A failure leaves nothing in flight: the rule is still Low,
 * the row is terminal, and the next cycle starts another attempt thirty seconds
 * later. Nothing about a failed carve fixes itself in thirty seconds — a wallet
 * short of the amount, a node that will not take a deposit, a head the operator
 * has to look at — so the retry fails the same way, forever.
 *
 * That is not just noise. Every attempt writes a `HydraTopup` row and a
 * `HydraHeadError`, about 2 880 of each a day, and the deposits view is
 * unfiltered: a genuinely stranded deposit with a Recover button waiting on it
 * is pushed off the first page by the failures of a rule nobody has looked at.
 *
 * So back off per participant, doubling from five minutes to an hour. The cap
 * keeps a rule that recovers on its own — a wallet refilled, a node restarted —
 * picking itself up within the hour without an operator, while turning 2 880
 * attempts a day into at most 24.
 */
export const AUTO_TOPUP_BACKOFF_BASE_MS = 5 * 60 * 1000;
export const AUTO_TOPUP_BACKOFF_MAX_MS = 60 * 60 * 1000;

/**
 * How many recent attempts the backoff reads.
 *
 * Only the unbroken run of failures at the head of the list counts, and the
 * cap is reached after five, so reading more would change nothing.
 */
export const AUTO_TOPUP_BACKOFF_SAMPLE = 8;

export type AutoTopupAttempt = {
	status: HydraTopupStatus;
	/**
	 * When the attempt was made.
	 *
	 * `createdAt`, emphatically not `updatedAt`. A failed deposit keeps its
	 * `depositTxHash`, which leaves it in `reconcileRecoveredHydraTopups`'
	 * candidate set forever, and that sweep rotates `updatedAt` to now on every
	 * tick so an unresolvable row cannot starve its fixed budget. Aged off
	 * `updatedAt`, the newest failure is always seconds old, the wait never
	 * elapses, and auto top-up for that participant stops for good — the silent
	 * stop this backoff had to avoid, arrived at from the other side.
	 *
	 * The cost is that the wait is measured from when the attempt started rather
	 * than from when it failed, so a deposit that fails at its deadline is
	 * retried sooner than the nominal backoff. The run still grows, so it still
	 * converges on the cap.
	 */
	createdAt: Date;
};

export type AutoTopupBackoff = {
	consecutiveFailures: number;
	/** When the next attempt may run, or null when nothing is holding it back. */
	retryAt: Date | null;
	blocked: boolean;
};

/** Doubling from the base, capped. `failures` is the unbroken run, newest first. */
export function autoTopupBackoffMs(failures: number): number {
	if (failures <= 0) return 0;
	const doubled = AUTO_TOPUP_BACKOFF_BASE_MS * 2 ** (failures - 1);
	return Math.min(doubled, AUTO_TOPUP_BACKOFF_MAX_MS);
}

/**
 * Whether this participant's next auto top-up should wait.
 *
 * `attempts` is that participant's own recent top-ups, newest attempt first.
 * The caller has already skipped the rule when a deposit is in flight, so a row
 * here has settled one way or the other; a run interrupted by an absorbed or
 * recovered top-up is not a run.
 */
export function evaluateAutoTopupBackoff(attempts: readonly AutoTopupAttempt[], now: Date): AutoTopupBackoff {
	let consecutiveFailures = 0;
	for (const attempt of attempts) {
		if (attempt.status !== HydraTopupStatus.Failed) break;
		consecutiveFailures += 1;
	}
	if (consecutiveFailures === 0) return { consecutiveFailures: 0, retryAt: null, blocked: false };

	const lastFailure = attempts[0]?.createdAt;
	if (lastFailure === undefined || !Number.isFinite(lastFailure.getTime())) {
		// A row whose timestamp cannot be read is not a licence to retry every
		// thirty seconds. Hold for the full wait the run has earned.
		return { consecutiveFailures, retryAt: null, blocked: true };
	}
	const retryAt = new Date(lastFailure.getTime() + autoTopupBackoffMs(consecutiveFailures));
	return { consecutiveFailures, retryAt, blocked: now.getTime() < retryAt.getTime() };
}
