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
 * Approved is when the value leaves the head, Finalized is when L1 has it.
 * An anonymous Finalized event can settle only a row whose approval was already
 * recorded. Its timestamp alone cannot identify an unsent local withdrawal.
 */

import { Mutex } from 'async-mutex';
import { HydraDecommitStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import type { DecommitDistributedValue, HydraDecommitOutcome } from '@/lib/hydra';
import { resolveDecommitPayoutTx } from './payout-lookup';
import { PENDING_EXPIRED_REASONS } from './stale';

/** Statuses a later event is still allowed to move away from. */
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
	 * Absent on finalization, which the head reports without one. The row is
	 * then matched by head, approved status and observedAt. A pending local row
	 * may not have been sent when a peer's finalization arrives.
	 * Without observedAt as well, the finalization is ignored.
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
			// time after the historical finalization. The age guard then uses
			// the row's creation time instead.
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
 * Record that L1 has the funds.
 *
 * Split out because it is the one transition the head reports anonymously.
 * DecommitFinalized carries no transaction id, so the row is found by head and
 * recorded Approved status; the id it does not carry is then looked up on chain, because the
 * in-head decommit id is not a transaction any explorer has ever seen.
 */
async function finalizeDecommit(params: {
	hydraHeadId: string;
	decommitTxId?: string;
	distributed?: DecommitDistributedValue;
	observedAt?: Date;
	now: Date;
}): Promise<boolean> {
	const { hydraHeadId, decommitTxId, distributed, observedAt, now } = params;

	// An anonymous finalization is attributed by head, approval, and age. Without a
	// time the age filter has nothing to compare, so a replayed finalization
	// from an earlier withdrawal would settle the one open today. The frame
	// parser already turns a missing or unparseable timestamp into undefined.
	if (decommitTxId === undefined && observedAt === undefined) {
		logger.warn(
			`[HydraDecommit] head ${hydraHeadId} reported a finalization with neither a withdrawal id nor a time; ignoring it`,
		);
		return false;
	}

	const open = await prisma.hydraDecommit.findMany({
		where: {
			hydraHeadId,
			AND: [
				decommitTxId === undefined
					? { status: HydraDecommitStatus.Approved }
					: { decommitTxId, OR: [{ status: { in: OPEN_STATUSES } }, EXPIRED] },
				// A head replays its entire history on every reconnection, so a
				// finalization from weeks ago arrives again alongside today's pending
				// withdrawal. Without this the old event is attributed to the new
				// withdrawal and reports money as paid out that is still in the head.
				//
				// Filtered on the approval rather than on creation: a finalization
				// cannot precede the approval it follows, so this excludes a withdrawal
				// that was merely requested in the seconds before the replayed event.
				//
				// An Approved row may have a null approval time after an expired row
				// was revived by a replayed approval with no timestamp. Its creation
				// time still bounds the anonymous finalization in that case.
				...(observedAt === undefined
					? []
					: [{ OR: [{ approvedAt: { lte: observedAt } }, { approvedAt: null, createdAt: { lte: observedAt } }] }]),
			],
		},
		orderBy: { createdAt: 'desc' },
	});
	if (open.length === 0) return false;
	// An anonymous finalization can only be attributed when there is exactly one
	// candidate. Normally there is, because a participant may have only one
	// withdrawal in flight; if that ever stops holding, refusing to guess is the
	// only safe answer, since guessing wrong marks the wrong withdrawal paid.
	if (decommitTxId === undefined && open.length > 1) {
		logger.warn(
			`[HydraDecommit] head ${hydraHeadId} reported a finalization while ${open.length} withdrawals were open; ` +
				'leaving them alone rather than attributing it to the wrong one',
		);
		return false;
	}
	const [row] = open;
	if (!row) return false;

	// Stamp an absent approval time too. An Approved row can lack that time after
	// an expired row was revived by a replayed approval without a timestamp.
	await prisma.hydraDecommit.update({
		where: { id: row.id },
		data: {
			status: HydraDecommitStatus.Finalized,
			finalizedAt: now,
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
	logger.info(`[HydraDecommit] withdrawal ${row.id} settled on L1`);

	// After the status, and never blocking it. Identifying the payout is a
	// convenience for whoever reads the row; failing to identify it must not make
	// a settled withdrawal look unsettled.
	if (distributed) {
		void resolveDecommitPayoutTx({ decommitId: row.id, distributed }).catch((error: unknown) => {
			logger.warn(`[HydraDecommit] could not identify the payout transaction for ${row.id}: ${String(error)}`);
		});
	}
	return true;
}
