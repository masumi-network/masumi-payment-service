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
	lockFunds: web3CardanoV2.lockFundsL2,
	submitResult: web3CardanoV2.submitResultL2,
} as const;

export type HydraNudgeKind = keyof typeof CYCLES;

/**
 * How long after starting a cycle further nudges for it are ignored.
 *
 * A cycle picks up everything eligible when it runs, so a second request
 * arriving while one is in flight is already covered. Without this, ten
 * purchases in a second would queue ten cycles, each doing the same scan.
 */
const NUDGE_COOLDOWN_MS = 1_000;

const lastNudgedAt = new Map<HydraNudgeKind, number>();
const running = new Set<HydraNudgeKind>();

/**
 * Ask the matching cycle to run now.
 *
 * Returns immediately. Never throws: the caller's work is already committed and
 * the scheduled tick remains the backstop.
 */
export function nudgeHydraCycle(kind: HydraNudgeKind): void {
	const now = Date.now();
	const last = lastNudgedAt.get(kind);
	if (running.has(kind) || (last !== undefined && now - last < NUDGE_COOLDOWN_MS)) {
		return;
	}

	lastNudgedAt.set(kind, now);
	running.add(kind);
	void CYCLES[kind]()
		.catch((error: unknown) => {
			// The scheduled run will try again, so this is a note rather than an
			// incident.
			logger.warn(`hydra-nudge: ${kind} cycle failed when run on demand: ${(error as Error).message}`);
		})
		.finally(() => {
			running.delete(kind);
		});
}
