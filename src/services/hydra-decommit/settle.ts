/**
 * Recording what the head decided about a withdrawal.
 *
 * The request that started a withdrawal is long gone by the time any of this
 * arrives: the head answers over its socket, minutes later, possibly after this
 * process has restarted and replayed its history. So every transition is driven
 * from the node's events rather than from the call that made the request, and
 * each one is written defensively — replay means the same event can be seen more
 * than once, and a restart means they can be seen out of order.
 *
 * The ordering rule is the only subtle part: Approved is when the value leaves
 * the head, Finalized is when L1 has it. A Finalized seen without its Approved
 * still implies the approval happened, but an Approved seen after a Finalized is
 * a replay and must not undo it.
 */

import { HydraDecommitStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import type { HydraDecommitOutcome } from '@/lib/hydra';

/** Statuses a later event is still allowed to move away from. */
const OPEN_STATUSES = [HydraDecommitStatus.Preparing, HydraDecommitStatus.Pending, HydraDecommitStatus.Approved];

export async function applyDecommitOutcome(params: {
	hydraHeadId: string;
	decommitTxId: string;
	outcome: HydraDecommitOutcome;
	reason?: string;
}): Promise<boolean> {
	const { hydraHeadId, decommitTxId, outcome, reason } = params;
	const now = new Date();

	// Scoped by head as well as by transaction id. The id alone is unique in
	// practice, but a withdrawal belongs to one head and an event from another
	// one must never move it.
	const where = {
		hydraHeadId,
		decommitTxId,
		status: { in: OPEN_STATUSES },
	};

	if (outcome === 'invalid') {
		const { count } = await prisma.hydraDecommit.updateMany({
			// A refusal cannot undo an approval: once the head has signed the
			// removal the funds are out, and a late DecommitInvalid for the same id
			// would otherwise report money as still in the head when it is not.
			where: { ...where, status: { in: [HydraDecommitStatus.Preparing, HydraDecommitStatus.Pending] } },
			data: { status: HydraDecommitStatus.Failed, failureReason: reason ?? 'the head refused the withdrawal' },
		});
		if (count > 0) {
			logger.warn(`[HydraDecommit] head refused withdrawal ${decommitTxId}: ${reason ?? 'no reason given'}`);
		}
		return count > 0;
	}

	if (outcome === 'approved') {
		const { count } = await prisma.hydraDecommit.updateMany({
			where: { ...where, status: { in: [HydraDecommitStatus.Preparing, HydraDecommitStatus.Pending] } },
			data: { status: HydraDecommitStatus.Approved, approvedAt: now },
		});
		if (count > 0) {
			logger.info(`[HydraDecommit] head approved withdrawal ${decommitTxId}; the funds have left the head`);
		}
		return count > 0;
	}

	// Finalized. Stamp the approval too when it was never seen — a replay that
	// starts mid-history, or a restart between the two events, would otherwise
	// leave a finalized withdrawal claiming it was never approved.
	const { count } = await prisma.hydraDecommit.updateMany({
		where,
		data: { status: HydraDecommitStatus.Finalized, finalizedAt: now },
	});
	if (count > 0) {
		await prisma.hydraDecommit.updateMany({
			where: { hydraHeadId, decommitTxId, approvedAt: null },
			data: { approvedAt: now },
		});
		logger.info(`[HydraDecommit] withdrawal ${decommitTxId} settled on L1`);
	}
	return count > 0;
}
