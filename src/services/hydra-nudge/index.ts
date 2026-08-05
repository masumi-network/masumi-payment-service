/**
 * Start the Hydra work now, rather than when the next batch tick comes round.
 *
 * L1 work is paced by the chain: a batch waits because a transaction has to be
 * built, submitted and confirmed, and doing that more often does not make it
 * land sooner. L2 work has none of that. A funds-lock inside an open head is a
 * signature exchange between two nodes that completes in under a second, so
 * every second it spends waiting for a timer is pure latency added by us.
 *
 * The cycles already run on a timer and are written to be safe on any tick, so
 * this does not introduce a new path: it runs the same cycle earlier. What it
 * adds is a guard against a burst of requests each starting one, since a cycle
 * that is already running will pick up work created a moment ago anyway.
 *
 * Deliberately fire-and-forget. The request that triggers it has already done
 * its own work durably; if the nudge fails, the timer still comes round, so a
 * nudge failure must never fail the request that caused it.
 */

import { logger } from '@masumi/payment-core/logger';
import { web3CardanoV2 } from '@/services/payment-source-types';

/**
 * The head-only pass for each kind of work.
 *
 * These are the L2 halves of their cycles, never the whole cycle. Running a full
 * cycle early would drag the L1 batch forward with it, and L1 is batched on
 * purpose: the chain paces it, and going more often does not make anything land
 * sooner. A request the head declines is simply left alone here and picked up by
 * the normal tick, which is what makes the fallback to L1 keep its usual timing.
 *
 * Named for what the caller just did rather than for the service that owns the
 * pass.
 */
const CYCLES = {
	// One per redeemer the V2 contract accepts that has a head path.
	lockFunds: web3CardanoV2.lockFundsL2,
	submitResult: web3CardanoV2.submitResultL2, // SubmitResult
	collect: web3CardanoV2.collectL2, // Withdraw
	requestRefund: web3CardanoV2.requestRefundL2, // SetRefundRequested
	authorizeWithdrawal: web3CardanoV2.authorizeWithdrawalL2, // AuthorizeWithdrawal
	authorizeRefund: web3CardanoV2.authorizeRefundL2, // AuthorizeRefund
	collectRefund: web3CardanoV2.collectRefundL2, // WithdrawRefund
} as const;

export type HydraNudgeKind = keyof typeof CYCLES;

/**
 * How closely together two passes of the same kind may start.
 *
 * A pass picks up everything eligible when it runs, so ten purchases in a second
 * do not need ten identical scans. This is a rate limit, not a filter: a nudge
 * inside the window is remembered and run at the end of it, never dropped.
 *
 * Per process, deliberately. Two instances each get their own window and can
 * therefore each start a pass, which is harmless: the passes share a mutex per
 * service, so the second finds the first already running and returns.
 */
const NUDGE_COOLDOWN_MS = 1_000;

const lastStartedAt = new Map<HydraNudgeKind, number>();
const running = new Set<HydraNudgeKind>();
/**
 * Kinds nudged while their pass was running or inside the rate-limit window.
 *
 * Dropping those was the reason a purchase could sit still while its head was
 * open and idle. A pass reads each wallet once, near its start; a wallet that
 * frees a moment later — which is exactly when the lock it was holding gets
 * confirmed — is still busy as far as that pass is concerned. Discarding the
 * nudge that reports it left the waiting purchase for the next timer tick, so
 * the queue drained at one lock per tick instead of one per confirmation.
 */
const pending = new Set<HydraNudgeKind>();
const timers = new Map<HydraNudgeKind, NodeJS.Timeout>();

/**
 * Ask the matching cycle to run now.
 *
 * Returns immediately. Never throws: the caller's work is already committed and
 * the scheduled tick remains the backstop.
 */
export function nudgeHydraCycle(kind: HydraNudgeKind): void {
	if (running.has(kind)) {
		// Run once more when this pass ends, against the state it could not see.
		pending.add(kind);
		return;
	}

	const last = lastStartedAt.get(kind);
	const waitMs = last === undefined ? 0 : NUDGE_COOLDOWN_MS - (Date.now() - last);
	if (waitMs > 0) {
		scheduleNudge(kind, waitMs);
		return;
	}

	startNudge(kind);
}

/** Run at the end of the rate-limit window. One timer per kind. */
function scheduleNudge(kind: HydraNudgeKind, waitMs: number): void {
	if (timers.has(kind)) return;
	const timer = setTimeout(() => {
		timers.delete(kind);
		if (running.has(kind)) {
			pending.add(kind);
			return;
		}
		startNudge(kind);
	}, waitMs);
	// A deferred nudge is an optimisation, never a reason to keep the process up.
	timer.unref?.();
	timers.set(kind, timer);
}

function startNudge(kind: HydraNudgeKind): void {
	lastStartedAt.set(kind, Date.now());
	running.add(kind);
	pending.delete(kind);
	void CYCLES[kind]()
		.catch((error: unknown) => {
			// The scheduled run will try again, so this is a note rather than an
			// incident.
			logger.warn(`hydra-nudge: ${kind} cycle failed when run on demand: ${(error as Error).message}`);
		})
		.finally(() => {
			running.delete(kind);
			if (pending.delete(kind)) {
				// Straight back through the front door so the rate limit still applies:
				// a pass shorter than the window defers rather than spinning.
				nudgeHydraCycle(kind);
			}
		});
}
