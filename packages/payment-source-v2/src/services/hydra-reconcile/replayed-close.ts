import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { HydraHeadStatus } from '@/generated/prisma/client';
import type { HydraNode } from '@/lib/hydra/hydra/node';

/** Statuses whose snapshot a close or contest has fixed on chain. */
const CLOSED_HEAD_STATUSES: HydraHeadStatus[] = [
	HydraHeadStatus.Closed,
	HydraHeadStatus.FanoutPossible,
	HydraHeadStatus.FanningOut,
	HydraHeadStatus.Final,
];
/** Of those, the statuses in which the contestation deadline still matters. */
const CONTESTABLE_HEAD_STATUSES: HydraHeadStatus[] = [HydraHeadStatus.Closed, HydraHeadStatus.FanoutPossible];

export type ReplayedCloseNode = Pick<HydraNode, 'status' | 'closedSnapshotNumber' | 'fetchClosedHeadFacts'>;

/**
 * Persist the snapshot of a close or contest that this service saw only in the
 * replayed history.
 *
 * A contest moves the head to a newer snapshot, and the fanout pays out that
 * snapshot. The live frame carries its number, but a contest that happened while
 * the service was down or disconnected reaches it only through the history. The
 * row then keeps the older close's number, and the fanout handoff, which expects
 * the row's number, never completes.
 *
 * The caller has checked that the history pass is complete and bound to this
 * head. The write changes no status, so it cannot look like a regression, and
 * it only raises the number on a row that is still closed and not handed off.
 * The deadline moves only later, because each contest extends it.
 *
 * Returns true when it raised the row. The caller then ends this pass, so the
 * next pass reads the new number.
 */
export async function recordReplayedCloseSnapshot(
	hydraHeadId: string,
	latestSnapshotNumber: bigint,
	node: ReplayedCloseNode,
): Promise<boolean> {
	const closedSnapshotNumber = node.closedSnapshotNumber;
	if (closedSnapshotNumber === undefined || closedSnapshotNumber <= latestSnapshotNumber) return false;
	// A live status outside the closed family means a rollback undid the close.
	if (!CLOSED_HEAD_STATUSES.includes(node.status)) return false;

	// The deadline goes first, and a head state the node did not return holds the
	// raise: once the snapshot is current, no later pass tries the deadline again.
	// A Final head skips this, so its handoff never waits on the read.
	if (CONTESTABLE_HEAD_STATUSES.includes(node.status) && !(await recordLaterDeadline(hydraHeadId, node))) {
		return false;
	}

	const raised = await prisma.hydraHead.updateMany({
		where: {
			id: hydraHeadId,
			isEnabled: true,
			status: { in: CLOSED_HEAD_STATUSES },
			reconciliationCompletedAt: null,
			latestSnapshotNumber: { lt: closedSnapshotNumber },
		},
		data: { latestSnapshotNumber: closedSnapshotNumber },
	});
	if (raised.count !== 1) return false;
	logger.info('[HydraReconcile] Recorded the snapshot of a close or contest found in the replayed history', {
		hydraHeadId,
		previousSnapshotNumber: latestSnapshotNumber.toString(),
		closedSnapshotNumber: closedSnapshotNumber.toString(),
	});
	return true;
}

/** False when the node did not return its head state, so the caller can try again. */
async function recordLaterDeadline(hydraHeadId: string, node: ReplayedCloseNode): Promise<boolean> {
	const facts = await node.fetchClosedHeadFacts();
	if (!facts) return false;
	const deadline = new Date(facts.contestationDeadline);
	if (!Number.isFinite(deadline.getTime())) {
		logger.warn('[HydraReconcile] Ignoring unparseable contestationDeadline in the node head state', {
			hydraHeadId,
			contestationDeadline: facts.contestationDeadline,
		});
		// A retry would read the same value, so the snapshot goes ahead without it.
		return true;
	}
	await prisma.hydraHead.updateMany({
		where: {
			id: hydraHeadId,
			isEnabled: true,
			status: { in: CONTESTABLE_HEAD_STATUSES },
			OR: [{ contestationDeadline: null }, { contestationDeadline: { lt: deadline } }],
		},
		data: { contestationDeadline: deadline },
	});
	return true;
}
