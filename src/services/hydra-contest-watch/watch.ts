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
import { HydraErrorType, HydraHeadStatus, Prisma } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { webhookEventsService } from '@/services/webhooks/events.service';
import { HydraPersistenceRotationError, HydraProtocolError, HydraTransportError } from '@/lib/hydra/hydra/errors';
import type { HydraNode } from '@/lib/hydra/hydra/node';
import { applyObservationGap, nodeUnobservedCause, type UnobservedCause } from './observation-gap';
import {
	ContestObserverConfigurationError,
	readOnlyContestNode,
	releaseUnusedContestObservers,
} from './read-only-observer';

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

type ContestWatchDatabase = Pick<typeof prisma, 'hydraHead' | '$transaction'>;

/**
 * Claim the alert, record the error and queue the webhook in one transaction.
 * A failed write rolls the claim back, so the next tick alerts again instead of
 * losing the alert for good.
 */
async function claimAndAnnounceContestGap(
	database: ContestWatchDatabase,
	claim: (tx: Prisma.TransactionClient) => Promise<{ count: number }>,
	hydraHeadId: string,
	observed: ContestObservation,
	gapSince: Date,
	now: Date,
): Promise<boolean> {
	const message = `The head is closed on snapshot ${observed.closedSnapshotNumber} and no contest put snapshot ${observed.verifiedSnapshotNumber} on chain. A fanout pays out the older snapshot.`;
	const isAnnounced = await database.$transaction(async (tx) => {
		const claimed = await claim(tx);
		if (claimed.count !== 1) return false;
		await tx.hydraHeadError.create({
			data: {
				hydraHeadId,
				errorType: HydraErrorType.ContestMissing,
				errorMessage: message,
				headStatus: observed.status,
				clientInput: 'ContestWatch',
				errorAt: now,
			},
		});
		await webhookEventsService.queueHydraHeadContestMissingInTransaction(tx, {
			hydraHeadId,
			headStatus: observed.status,
			closedSnapshotNumber: Number(observed.closedSnapshotNumber),
			verifiedSnapshotNumber: Number(observed.verifiedSnapshotNumber),
			gapSince: gapSince.toISOString(),
			checkedAt: now.toISOString(),
		});
		return true;
	});
	if (isAnnounced) {
		logger.warn('[HydraContestWatch] no contest landed for a newer snapshot', {
			hydraHeadId,
			headStatus: observed.status,
			closedSnapshotNumber: observed.closedSnapshotNumber.toString(),
			verifiedSnapshotNumber: observed.verifiedSnapshotNumber.toString(),
			gapSince: gapSince.toISOString(),
		});
	}
	return isAnnounced;
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
	database: ContestWatchDatabase = prisma,
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
			const data = {
				contestGapSignature: decision.signature,
				contestGapSince: now,
				contestGapAlertedAt: decision.isAlerting ? now : null,
			};
			if (!decision.isAlerting) {
				await database.hydraHead.updateMany({ where: readState, data });
				break;
			}
			await claimAndAnnounceContestGap(
				database,
				(tx) => tx.hydraHead.updateMany({ where: readState, data }),
				head.id,
				observed,
				now,
				now,
			);
			break;
		}
		case 'alert': {
			if (head.contestGapSince === null) return 'unchanged';
			const isAnnounced = await claimAndAnnounceContestGap(
				database,
				(tx) =>
					tx.hydraHead.updateMany({
						where: { ...readState, contestGapAlertedAt: null },
						data: { contestGapAlertedAt: now },
					}),
				head.id,
				observed,
				head.contestGapSince,
				now,
			);
			if (!isAnnounced) return 'unchanged';
			break;
		}
		case 'unchanged':
			break;
	}
	return decision.action;
}

/**
 * Why a read-only observer session failed. A node that cannot be reached, or
 * that answers for another head or party, may not contest. A rotated event log
 * or a bad stored configuration is this service's to fix.
 */
function connectFailureCause(error: unknown, message: string): UnobservedCause {
	if (error instanceof ContestObserverConfigurationError) {
		return { reason: `this service could not load the head configuration (${message})`, isNodeSide: false };
	}
	if (error instanceof HydraTransportError) {
		return { reason: `this service could not reach the node (${message})`, isNodeSide: true };
	}
	if (error instanceof HydraProtocolError && !(error instanceof HydraPersistenceRotationError)) {
		return { reason: `the node did not prove it serves this head (${message})`, isNodeSide: true };
	}
	return { reason: `this service could not observe the node (${message})`, isNodeSide: false };
}

/** Compare authenticated node history even while the payment session is quarantined. */
export async function runHydraContestWatch(): Promise<void> {
	const heads = await prisma.hydraHead.findMany({
		where: {
			status: { in: [HydraHeadStatus.Open, HydraHeadStatus.Closed, HydraHeadStatus.FanoutPossible] },
			retiredAt: null,
			LocalParticipant: { isNot: null },
		},
		select: {
			id: true,
			status: true,
			isEnabled: true,
			contestGapSignature: true,
			contestGapSince: true,
			contestGapAlertedAt: true,
			contestationPeriod: true,
			contestationDeadline: true,
			observationGapSince: true,
			observationGapAlertedAt: true,
			observationGapAlertedNodeSide: true,
			observationCheckedAt: true,
		},
	});
	const connectionManager = getHydraConnectionManager();
	const needsReadOnlyObserver = new Set<string>();
	// An unavailable observer must not delay alerts for another head's deadline.
	await Promise.allSettled(
		heads.map(async (head) => {
			let node: HydraNode | null = null;
			let unobservedCause: UnobservedCause | null;
			try {
				node = head.isEnabled ? connectionManager.getNode(head.id) : null;
				if (!node) {
					needsReadOnlyObserver.add(head.id);
					node = await readOnlyContestNode(head.id);
				}
				unobservedCause = nodeUnobservedCause(node);
			} catch (error) {
				const message = error instanceof Error ? error.message : 'Unknown error';
				unobservedCause = connectFailureCause(error, message);
				logger.warn('[HydraContestWatch] could not reach the head node', { hydraHeadId: head.id, error: message });
			}
			try {
				await applyObservationGap(head, unobservedCause, new Date());
			} catch (error) {
				logger.warn('[HydraContestWatch] could not record whether the head node is observed', {
					hydraHeadId: head.id,
					error: error instanceof Error ? error.message : 'Unknown error',
				});
			}
			if (!node) return;
			try {
				// Durable status may still say Open after a lifecycle write failed.
				// Use the pinned node's observed close status, never that stale row.
				if (node.status !== HydraHeadStatus.Closed && node.status !== HydraHeadStatus.FanoutPossible) return;
				const closedSnapshotNumber = node.closedSnapshotNumber;
				const verifiedSnapshotNumber = node.verifiedSnapshotNumber;
				if (closedSnapshotNumber === undefined || verifiedSnapshotNumber === undefined) return;
				await applyContestGapObservation(
					head,
					{ status: node.status, closedSnapshotNumber, verifiedSnapshotNumber },
					new Date(),
				);
			} catch (error) {
				logger.warn('[HydraContestWatch] could not compare the head with the chain', {
					hydraHeadId: head.id,
					error: error instanceof Error ? error.message : 'Unknown error',
				});
			}
		}),
	);
	await releaseUnusedContestObservers(needsReadOnlyObserver);
}
