/**
 * Recording what the head decided about a withdrawal.
 *
 * The request that started a withdrawal is long gone by the time any of this
 * arrives: the head answers over its socket, minutes later, possibly after this
 * process has restarted and replayed its history. Approval and finalization
 * arrive through the node's events. A direct refusal of our request is handled
 * by the caller. Each transition is written defensively because replay can
 * repeat events, and a restart can deliver them out of order.
 *
 * Approved is when the value leaves the head. A node finalization only records
 * an L1 observation; an independent depth check later marks it Finalized.
 * A finalization must name the withdrawal, including one correlated by replay.
 */

import { Mutex } from 'async-mutex';
import { HydraDecommitStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import type { DecommitDistributedValue, HydraDecommitOutcome } from '@/lib/hydra';
import { resolveDecommitPayoutTx } from './payout-lookup';
import { PENDING_EXPIRED_REASONS } from './stale';

/** Statuses a later node event is still allowed to move away from. */
const OPEN_STATUSES = [HydraDecommitStatus.Preparing, HydraDecommitStatus.Pending, HydraDecommitStatus.Approved];

/**
 * A Pending row this service gave up on without hearing from the head.
 *
 * Expiry is a guess that the head never took the request, so the head's own
 * answer must still win. Only an outcome that names the transaction may replace
 * it: an anonymous finalization could belong to any withdrawal of the head.
 */
const EXPIRED = { status: HydraDecommitStatus.Failed, failureReason: { in: PENDING_EXPIRED_REASONS } };

/**
 * One outcome at a time per head, in the order the node reported them.
 *
 * Outcomes are emitted fire-and-forget, so without this a replayed approval and
 * the finalization that followed it race. A finalization that reads its rows
 * before the approval has re-opened an expired one never finds it, and the
 * approval then leaves that row Approved with nothing left to finalize it.
 * The mutex queues waiters first-in-first-out, which keeps the node's order.
 */
const outcomeLocks = new Map<string, Mutex>();

type DecommitOutcomeParams = {
	hydraHeadId: string;
	/**
	 * Recovered from the preceding approval when Hydra omits it. Finalizations
	 * without this identity are ignored: head and age can also match a peer's.
	 */
	decommitTxId?: string;
	outcome: HydraDecommitOutcome;
	reason?: string;
	/** What reached L1, when the head said so. Only meaningful on finalization. */
	distributed?: DecommitDistributedValue;
	/** When the head produced the event. See finalizeDecommit for why it matters. */
	observedAt?: Date;
};

export async function applyDecommitOutcome(params: DecommitOutcomeParams): Promise<boolean> {
	let lock = outcomeLocks.get(params.hydraHeadId);
	if (lock === undefined) {
		lock = new Mutex();
		outcomeLocks.set(params.hydraHeadId, lock);
	}
	return await lock.runExclusive(() => applyDecommitOutcomeInOrder(params));
}

async function applyDecommitOutcomeInOrder(params: DecommitOutcomeParams): Promise<boolean> {
	const { hydraHeadId, decommitTxId, outcome, reason, distributed, observedAt } = params;
	const now = new Date();

	if (outcome === 'finalized') {
		return finalizeDecommit({ hydraHeadId, decommitTxId, distributed, observedAt, now });
	}
	if (decommitTxId === undefined) {
		// Only finalization arrives without one; anything else that does is a
		// message shape this service does not understand, and guessing which
		// withdrawal it meant would be worse than ignoring it.
		logger.warn(`[HydraDecommit] ignoring a ${outcome} outcome that named no withdrawal`);
		return false;
	}

	if (outcome === 'invalid') {
		// DecommitInvalid is broadcast for any participant's submission. Its tx id
		// hashes the body but not its witnesses, so it cannot identify our signed
		// request. A peer's rejected submission must not fail our Pending row.
		// The caller handles a direct rejection; ambiguous requests can expire
		// after the node confirms it has no withdrawal in flight.
		logger.debug(`[HydraDecommit] ignoring uncorrelated rejection for ${decommitTxId}: ${reason ?? 'no reason given'}`);
		return false;
	}

	if (outcome === 'approved') {
		// Scoped by head as well as by transaction id. An event from another
		// head must never move this withdrawal.
		const undecidedStatus = { status: { in: [HydraDecommitStatus.Preparing, HydraDecommitStatus.Pending] } };
		// Receipt time can follow the historical finalization replayed next.
		// Preserve the node's event time, including when repairing a missing
		// or replay-time stamp on this exact withdrawal's Approved row.
		const approvedAt = observedAt ?? now;
		let { count } = await prisma.hydraDecommit.updateMany({
			where: {
				hydraHeadId,
				decommitTxId,
				OR: [
					undecidedStatus,
					...(observedAt === undefined
						? []
						: [
								{
									status: HydraDecommitStatus.Approved,
									OR: [{ approvedAt: null }, { approvedAt: { gt: observedAt } }],
								},
							]),
				],
			},
			data: { status: HydraDecommitStatus.Approved, approvedAt },
		});
		if (count === 0) {
			// An expired row hears of its approval through replay. If that frame
			// omits its time, leave the approval null rather than stamp receipt
			// time after the historical finalization. Exact transaction identity
			// still lets the finalization record this withdrawal later.
			({ count } = await prisma.hydraDecommit.updateMany({
				where: { hydraHeadId, decommitTxId, ...EXPIRED },
				data: {
					status: HydraDecommitStatus.Approved,
					failureReason: null,
					...(observedAt === undefined ? {} : { approvedAt: observedAt }),
				},
			}));
		}
		if (count > 0) {
			logger.info(`[HydraDecommit] head approved withdrawal ${decommitTxId}; the funds have left the head`);
		}
		return count > 0;
	}

	logger.warn(`[HydraDecommit] unhandled withdrawal outcome ${String(outcome)}`);
	return false;
}

/**
 * Record the node's claim that its L1 decrement was observed.
 *
 * Hydra omits the id, so each ordered socket correlates it with its preceding
 * approval before this writer sees it. Independent payout identity and depth
 * are still required before promoting the named row to Finalized.
 */
async function finalizeDecommit(params: {
	hydraHeadId: string;
	decommitTxId?: string;
	distributed?: DecommitDistributedValue;
	observedAt?: Date;
	now: Date;
}): Promise<boolean> {
	const { hydraHeadId, decommitTxId, distributed, observedAt, now } = params;

	if (decommitTxId === undefined) {
		logger.warn(`[HydraDecommit] head ${hydraHeadId} reported an uncorrelated finalization; ignoring it`);
		return false;
	}

	const open = await prisma.hydraDecommit.findMany({
		where: {
			hydraHeadId,
			decommitTxId,
			// Exact identity permits a replay to repair an earlier anonymous
			// attribution. Finalized rows stay immutable; independent L1 proof
			// still decides when an Approved row can become Finalized.
			OR: [{ status: { in: OPEN_STATUSES } }, EXPIRED],
		},
		orderBy: { createdAt: 'desc' },
	});
	const [row] = open;
	if (!row) return false;

	// Stamp an absent approval time too. An Approved row can lack that time after
	// an expired row was revived by a replayed approval without a timestamp.
	const { count } = await prisma.hydraDecommit.updateMany({
		// A detached payout lookup may have finalized the row since the read.
		where: { id: row.id, OR: [{ status: { in: OPEN_STATUSES } }, EXPIRED] },
		data: {
			status: HydraDecommitStatus.Approved,
			l1ObservedAt: observedAt ?? now,
			failureReason: null,
			...(row.approvedAt === null ? { approvedAt: now } : {}),
			// Beside what was asked for, never over it. The two differ routinely —
			// a decommit takes whole outputs and the decrement's fee comes out of
			// the value that travels — and that difference is only visible while
			// both are on the row.
			...(distributed === undefined
				? {}
				: { settledLovelace: distributed.lovelace, settledAssets: distributed.assets }),
		},
	});
	if (count === 0) return false;
	logger.info(`[HydraDecommit] withdrawal ${row.id} reported on L1; waiting for independent confirmation depth`);

	// A provider outage cannot promote the row. The scheduled pass retries this
	// same proof, so an outage here does not strand the withdrawal.
	if (distributed) {
		void resolveDecommitPayoutTx({ decommitId: row.id, distributed }).catch((error: unknown) => {
			logger.warn(`[HydraDecommit] could not identify the payout transaction for ${row.id}: ${String(error)}`);
		});
	} else {
		logger.warn(
			`[HydraDecommit] withdrawal ${row.id} has no distributed value; independent L1 finality needs recovery evidence`,
		);
	}
	return true;
}
