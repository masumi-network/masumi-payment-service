import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { HydraHeadStatus } from '@/generated/prisma/client';
import type { HydraNode } from '@/lib/hydra/hydra/node';

/** Statuses whose snapshot a close or contest has put on chain. */
const CLOSED_HEAD_STATUSES: HydraHeadStatus[] = [
	HydraHeadStatus.Closed,
	HydraHeadStatus.FanoutPossible,
	HydraHeadStatus.FanningOut,
	HydraHeadStatus.Final,
];

/**
 * Heads warned about a closed status with no close in the replay, so the warning
 * shows once. A close seen later clears the entry, so a later gap warns again.
 */
const headsWithoutReplayedClose = new Set<string>();

export type ReplayedCloseNode = Pick<HydraNode, 'status' | 'closedSnapshotNumber' | 'fetchClosedHeadFacts'>;

/**
 * Persist the snapshot of the last close or contest in the replayed history.
 *
 * A contest moves the head to a newer snapshot, and the fanout pays out that
 * snapshot. The history also holds the closes and contests that happened while
 * the service was down or disconnected, which no live frame brings back. A row
 * without the contested number keeps the older close's, and the fanout handoff,
 * which expects the row's number, never completes. If the node compacted the
 * close and contest frames away, the replay has no closed snapshot and nothing
 * is written.
 *
 * The caller has checked that the history pass is complete and bound to this
 * head. The write changes no status, so it cannot look like a regression, and
 * it only raises the number on a row that is still enabled, closed and not
 * handed off. While the head is Closed, its deadline moves too, only to a
 * later time, because each contest extends it. Past Closed the deadline has
 * passed, and nothing compares against its time any more.
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
	if (closedSnapshotNumber === undefined) {
		// Nothing else records the closed snapshot, so a handoff that waits on it needs a clue.
		if (CLOSED_HEAD_STATUSES.includes(node.status) && !headsWithoutReplayedClose.has(hydraHeadId)) {
			headsWithoutReplayedClose.add(hydraHeadId);
			// The live socket can report the close before the history socket reads it.
			logger.warn('[HydraReconcile] Closed head has no close or contest in its replayed history yet', {
				hydraHeadId,
				status: node.status,
				latestSnapshotNumber: latestSnapshotNumber.toString(),
			});
		}
		return false;
	}
	headsWithoutReplayedClose.delete(hydraHeadId);
	if (closedSnapshotNumber <= latestSnapshotNumber) return false;
	// A live status outside the closed family means a rollback undid the close.
	if (!CLOSED_HEAD_STATUSES.includes(node.status)) return false;

	// The deadline goes first, and a head state the node did not return holds the
	// raise: once the snapshot is current, no later pass tries the deadline again.
	// The hold ends with the Closed status, so a head past it, whose handoff needs
	// the raise, never waits on the read.
	if (node.status === HydraHeadStatus.Closed && !(await recordLaterDeadline(hydraHeadId, node))) return false;

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
			status: HydraHeadStatus.Closed,
			OR: [{ contestationDeadline: null }, { contestationDeadline: { lt: deadline } }],
		},
		data: { contestationDeadline: deadline },
	});
	return true;
}
