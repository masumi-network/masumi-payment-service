/**
 * Alert when this service cannot see a head's node.
 *
 * hydra-node contests a close on an older snapshot by itself, but only while it
 * runs. The contest gap check in `watch.ts` reads the node's view of the head,
 * so it stays silent in exactly the case where no contest can happen: the node
 * is down, unreachable, or has lost the head. This records when the node stopped
 * reporting a head state, and alerts once when that lasts `OBSERVATION_GRACE_MS`.
 */
import { HydraErrorType, HydraHeadStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { webhookEventsService } from '@/services/webhooks/events.service';

/** Long enough to ride out a restart or a reconnect, short against any contestation period worth running. */
export const OBSERVATION_GRACE_MS = 5 * 60_000;

/** States in which the node is running and follows this head. Anything else means no one will contest. */
const OBSERVED_NODE_STATUSES = new Set<HydraHeadStatus>([
	HydraHeadStatus.Open,
	HydraHeadStatus.Closed,
	HydraHeadStatus.FanoutPossible,
	HydraHeadStatus.FanningOut,
	HydraHeadStatus.Final,
]);

export function isHeadObserved(nodeStatus: HydraHeadStatus | undefined): boolean {
	return nodeStatus !== undefined && OBSERVED_NODE_STATUSES.has(nodeStatus);
}

export type StoredObservationGap = {
	observationGapSince: Date | null;
	observationGapAlertedAt: Date | null;
};

export type ObservationGapDecision =
	/** The node reports the head again: clear the recorded gap. */
	| 'clear'
	/** The node stopped reporting the head: start the clock. */
	| 'record'
	/** The gap outlived the grace period and has not been alerted. */
	| 'alert'
	/** Nothing to write. */
	| 'unchanged';

export function decideObservationGap(
	stored: StoredObservationGap,
	isObserved: boolean,
	now: Date,
): ObservationGapDecision {
	if (isObserved) return stored.observationGapSince === null ? 'unchanged' : 'clear';
	if (stored.observationGapSince === null) return 'record';
	if (stored.observationGapAlertedAt !== null) return 'unchanged';
	const isGraceOver = now.getTime() - stored.observationGapSince.getTime() >= OBSERVATION_GRACE_MS;
	return isGraceOver ? 'alert' : 'unchanged';
}

type ObservationGapDatabase = Pick<typeof prisma, 'hydraHead' | '$transaction'>;

export type ObservedHead = {
	id: string;
	status: HydraHeadStatus;
	contestationDeadline: Date | null;
} & StoredObservationGap;

/**
 * Apply one observation. Every write is conditioned on the gap start it read,
 * so two instances can never overwrite a newer gap or alert twice for one gap.
 * The alert claim, the error row and the webhook commit together: a failed
 * write rolls the claim back, and the next tick alerts again.
 */
export async function applyObservationGap(
	head: ObservedHead,
	isObserved: boolean,
	now: Date,
	database: ObservationGapDatabase = prisma,
): Promise<ObservationGapDecision> {
	const decision = decideObservationGap(head, isObserved, now);
	const gapSince = head.observationGapSince;
	switch (decision) {
		case 'clear':
			await database.hydraHead.updateMany({
				where: { id: head.id, observationGapSince: gapSince },
				data: { observationGapSince: null, observationGapAlertedAt: null },
			});
			return decision;
		case 'record':
			await database.hydraHead.updateMany({
				where: { id: head.id, observationGapSince: null },
				data: { observationGapSince: now, observationGapAlertedAt: null },
			});
			return decision;
		case 'alert': {
			if (gapSince === null) return 'unchanged';
			const isAnnounced = await database.$transaction(async (tx) => {
				const claimed = await tx.hydraHead.updateMany({
					where: { id: head.id, observationGapSince: gapSince, observationGapAlertedAt: null },
					data: { observationGapAlertedAt: now },
				});
				if (claimed.count !== 1) return false;
				await tx.hydraHeadError.create({
					data: {
						hydraHeadId: head.id,
						errorType: HydraErrorType.HeadUnobserved,
						errorMessage: `This service has not seen the node report this head since ${gapSince.toISOString()}. hydra-node contests a close on an older snapshot only while it runs. Restore the node before any contestation deadline passes.`,
						headStatus: head.status,
						clientInput: 'ContestWatch',
						errorAt: now,
					},
				});
				await webhookEventsService.queueHydraHeadUnobservedInTransaction(tx, {
					hydraHeadId: head.id,
					headStatus: head.status,
					contestationDeadline: head.contestationDeadline?.toISOString() ?? null,
					unobservedSince: gapSince.toISOString(),
					checkedAt: now.toISOString(),
				});
				return true;
			});
			if (!isAnnounced) return 'unchanged';
			logger.warn('[HydraContestWatch] the head node has not been observed for the grace period', {
				hydraHeadId: head.id,
				headStatus: head.status,
				unobservedSince: gapSince.toISOString(),
			});
			return decision;
		}
		case 'unchanged':
			return decision;
	}
}
