/**
 * Watchdog for a closed head that holds an older snapshot on chain than ours.
 *
 * When a party closes on an older snapshot than one every party signed,
 * hydra-node contests on its own. If that contest cannot be posted (no fuel, a
 * refused transaction), the node does not try again. Once the contestation
 * deadline passes, a fanout pays out the older snapshot, and what the newer one
 * moved is lost. A failed post alone does not prove this: another party may
 * contest with the same snapshot first.
 *
 * This compares the newest snapshot a close or contest put on chain with the
 * newest one this node verified. A gap that outlives `CONTEST_GRACE_MS`, or that
 * is still open when fanout becomes possible, is alerted once per gap.
 */
import { HydraErrorType, HydraHeadStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { recordHeadError } from '@/services/hydra-head-error/record';
import { webhookEventsService } from '@/services/webhooks/events.service';

/** A contest is posted and seen on chain within a few blocks. Two minutes without one is not a slow chain. */
export const CONTEST_GRACE_MS = 2 * 60_000;

export type StoredContestGap = {
	contestGapSignature: string | null;
	contestGapSince: Date | null;
	contestGapAlertedAt: Date | null;
};

export type ContestObservation = {
	status: HydraHeadStatus;
	/** Newest snapshot a close or contest put on chain. */
	closedSnapshotNumber: bigint;
	/** Newest snapshot every party signed, as this node verified it. */
	verifiedSnapshotNumber: bigint;
};

export type ContestGapDecision =
	/** No gap: clear whatever was recorded. */
	| { action: 'clear' }
	/** A gap we have not seen before: start its clock, and alert at once when fanout is already possible. */
	| { action: 'record'; signature: string; isAlerting: boolean }
	/** Nothing to write. */
	| { action: 'unchanged' }
	/** The same gap, past the grace period or past the deadline, not yet alerted. */
	| { action: 'alert' };

export function decideContestGap(
	stored: StoredContestGap,
	observed: ContestObservation,
	now: Date,
): ContestGapDecision {
	if (observed.verifiedSnapshotNumber <= observed.closedSnapshotNumber) {
		return stored.contestGapSignature === null && stored.contestGapSince === null
			? { action: 'unchanged' }
			: { action: 'clear' };
	}
	const isFanoutPossible = observed.status === HydraHeadStatus.FanoutPossible;
	const signature = `${observed.closedSnapshotNumber}<${observed.verifiedSnapshotNumber}`;
	if (stored.contestGapSignature !== signature || stored.contestGapSince === null) {
		return { action: 'record', signature, isAlerting: isFanoutPossible };
	}
	if (stored.contestGapAlertedAt !== null) return { action: 'unchanged' };
	const isGraceOver = now.getTime() - stored.contestGapSince.getTime() >= CONTEST_GRACE_MS;
	return isGraceOver || isFanoutPossible ? { action: 'alert' } : { action: 'unchanged' };
}

async function announceContestGap(
	hydraHeadId: string,
	observed: ContestObservation,
	gapSince: Date,
	now: Date,
): Promise<void> {
	const message = `The head is closed on snapshot ${observed.closedSnapshotNumber} and no contest put snapshot ${observed.verifiedSnapshotNumber} on chain. A fanout pays out the older snapshot.`;
	logger.warn('[HydraContestWatch] no contest landed for a newer snapshot', {
		hydraHeadId,
		headStatus: observed.status,
		closedSnapshotNumber: observed.closedSnapshotNumber.toString(),
		verifiedSnapshotNumber: observed.verifiedSnapshotNumber.toString(),
		gapSince: gapSince.toISOString(),
	});
	await recordHeadError(hydraHeadId, observed.status, HydraErrorType.ContestMissing, message, 'ContestWatch');
	await webhookEventsService.triggerHydraHeadContestMissing({
		hydraHeadId,
		headStatus: observed.status,
		closedSnapshotNumber: Number(observed.closedSnapshotNumber),
		verifiedSnapshotNumber: Number(observed.verifiedSnapshotNumber),
		gapSince: gapSince.toISOString(),
		checkedAt: now.toISOString(),
	});
}

/**
 * Apply one observation. Every write is conditioned on the signature it read,
 * so two instances can never overwrite a newer observation or alert twice for
 * one gap.
 */
export async function applyContestGapObservation(
	head: { id: string } & StoredContestGap,
	observed: ContestObservation,
	now: Date,
	database: Pick<typeof prisma, 'hydraHead'> = prisma,
): Promise<ContestGapDecision['action']> {
	const decision = decideContestGap(head, observed, now);
	const readState = { id: head.id, contestGapSignature: head.contestGapSignature };
	switch (decision.action) {
		case 'clear':
			await database.hydraHead.updateMany({
				where: readState,
				data: { contestGapSignature: null, contestGapSince: null, contestGapAlertedAt: null },
			});
			break;
		case 'record': {
			const recorded = await database.hydraHead.updateMany({
				where: readState,
				data: {
					contestGapSignature: decision.signature,
					contestGapSince: now,
					contestGapAlertedAt: decision.isAlerting ? now : null,
				},
			});
			if (decision.isAlerting && recorded.count === 1) await announceContestGap(head.id, observed, now, now);
			break;
		}
		case 'alert': {
			const claimed = await database.hydraHead.updateMany({
				where: { ...readState, contestGapAlertedAt: null },
				data: { contestGapAlertedAt: now },
			});
			if (claimed.count !== 1 || head.contestGapSince === null) return 'unchanged';
			await announceContestGap(head.id, observed, head.contestGapSince, now);
			break;
		}
		case 'unchanged':
			break;
	}
	return decision.action;
}

/** Scheduler entry: compare chain and node on every closed head this instance holds a session for. */
export async function runHydraContestWatch(): Promise<void> {
	const heads = await prisma.hydraHead.findMany({
		where: {
			status: { in: [HydraHeadStatus.Closed, HydraHeadStatus.FanoutPossible] },
			isEnabled: true,
			LocalParticipant: { isNot: null },
		},
		select: { id: true, status: true, contestGapSignature: true, contestGapSince: true, contestGapAlertedAt: true },
	});
	const connectionManager = getHydraConnectionManager();
	for (const head of heads) {
		// Only the instance that owns the head's session reads it; the others skip.
		const node = connectionManager.getNode(head.id);
		if (!node) continue;
		// Unknown is not "no gap": a node still replaying, or a session not yet
		// verified, must not clear a gap it cannot see.
		const closedSnapshotNumber = node.closedSnapshotNumber;
		const verifiedSnapshotNumber = node.verifiedSnapshotNumber;
		if (closedSnapshotNumber === undefined || verifiedSnapshotNumber === undefined) continue;
		try {
			await applyContestGapObservation(
				head,
				{ status: head.status, closedSnapshotNumber, verifiedSnapshotNumber },
				new Date(),
			);
		} catch (error) {
			logger.warn('[HydraContestWatch] could not compare the head with the chain', {
				hydraHeadId: head.id,
				error: error instanceof Error ? error.message : 'Unknown error',
			});
		}
	}
}
