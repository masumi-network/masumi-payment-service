/**
 * Alert when this service cannot see a head's node.
 *
 * hydra-node contests a close on an older snapshot by itself, but only while it
 * runs. The contest gap check in `watch.ts` reads the node's view of the head,
 * so it stays silent in exactly the case where no contest can happen: the node
 * is down, unreachable, has lost the head, or does not follow the chain. This
 * records when the service first could not observe the node, and alerts once
 * when that lasts the grace period.
 */
import { HydraErrorType, HydraHeadStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import type { HydraNode } from '@/lib/hydra/hydra/node';
import { webhookEventsService } from '@/services/webhooks/events.service';

/** Long enough to ride out a restart or a reconnect, short against any contestation period worth running. */
export const OBSERVATION_GRACE_MS = 5 * 60_000;

/**
 * A short contestation period gets at most this share of it as grace, so the
 * alert still arrives with most of the window left.
 */
const CONTESTATION_PERIOD_GRACE_DIVISOR = 4n;

/**
 * The watch checks every minute. A gap not checked for three minutes belongs to
 * an earlier outage or an earlier run of this service, and starts over.
 */
export const OBSERVATION_STALE_MS = 3 * 60_000;

/** States in which the node is running and follows this head. Anything else means no one will contest. */
const OBSERVED_NODE_STATUSES = new Set<HydraHeadStatus>([
	HydraHeadStatus.Open,
	HydraHeadStatus.Closed,
	HydraHeadStatus.FanoutPossible,
	HydraHeadStatus.FanningOut,
	HydraHeadStatus.Final,
]);

export type ObservableNode = Pick<
	HydraNode,
	| 'status'
	| 'hasVerifiedLiveSession'
	| 'hasVerifiedPinnedSessions'
	| 'confirmedTransactionHistoryError'
	| 'isChainSynced'
>;

/**
 * Why this service cannot observe the head. `isNodeSide` is true when the node
 * itself cannot contest, and false when the node may still contest but this
 * service cannot check it.
 */
export type UnobservedCause = { reason: string; isNodeSide: boolean };

/**
 * Why the node does not count as observed, or null when it does. A lost socket
 * leaves the node's last status in place, so the status alone is not enough:
 * the live session must still be bound to the head. The history replay is this
 * service's own check, so a replay that failed or is still running is reported
 * apart from a node that is down.
 */
export function nodeUnobservedCause(node: ObservableNode): UnobservedCause | null {
	if (!node.hasVerifiedLiveSession)
		return { reason: 'the node has no verified live session for this head', isNodeSide: true };
	if (!OBSERVED_NODE_STATUSES.has(node.status)) {
		return { reason: `the node reports the head as ${node.status}`, isNodeSide: true };
	}
	if (node.isChainSynced() === false) return { reason: 'the node does not follow the chain', isNodeSide: true };
	const replayError = node.confirmedTransactionHistoryError;
	if (replayError) {
		return { reason: `this service's replay of the node history failed (${replayError.message})`, isNodeSide: false };
	}
	if (!node.hasVerifiedPinnedSessions) {
		return { reason: "this service's replay of the node history has not finished", isNodeSide: false };
	}
	return null;
}

const NODE_SIDE_ADVICE =
	'hydra-node contests a close on an older snapshot only while it runs and follows the chain. Restore the node before any contestation deadline passes.';
const SERVICE_SIDE_ADVICE =
	'The node may still contest on its own, but this service cannot check a close against the newest signed snapshot. Check this service and its logs.';

export function observationGraceMs(contestationPeriodSeconds: bigint): number {
	const shareMs = (contestationPeriodSeconds * 1000n) / CONTESTATION_PERIOD_GRACE_DIVISOR;
	return Math.min(OBSERVATION_GRACE_MS, Number(shareMs));
}

export type StoredObservationGap = {
	observationGapSince: Date | null;
	observationGapAlertedAt: Date | null;
	observationCheckedAt: Date | null;
};

export type ObservationGapDecision =
	/** The node is observed again: clear the recorded gap. */
	| 'clear'
	/** A new gap, or one too old to belong to this outage: start the clock. */
	| 'record'
	/** The same gap, still inside the grace period or already alerted: note the check. */
	| 'touch'
	/** The gap outlived the grace period and has not been alerted. */
	| 'alert'
	/** Nothing to write. */
	| 'unchanged';

export function decideObservationGap(
	stored: StoredObservationGap,
	isObserved: boolean,
	now: Date,
	graceMs: number,
): ObservationGapDecision {
	if (isObserved) return stored.observationGapSince === null ? 'unchanged' : 'clear';
	const isStale =
		stored.observationCheckedAt === null ||
		now.getTime() - stored.observationCheckedAt.getTime() >= OBSERVATION_STALE_MS;
	if (stored.observationGapSince === null || isStale) return 'record';
	if (stored.observationGapAlertedAt !== null) return 'touch';
	const isGraceOver = now.getTime() - stored.observationGapSince.getTime() >= graceMs;
	return isGraceOver ? 'alert' : 'touch';
}

type ObservationGapDatabase = Pick<typeof prisma, 'hydraHead' | '$transaction'>;

export type ObservedHead = {
	id: string;
	status: HydraHeadStatus;
	contestationPeriod: bigint;
	contestationDeadline: Date | null;
} & StoredObservationGap;

/**
 * Apply one observation. `unobservedCause` is null when the node is observed.
 * Every write is conditioned on the gap start it read, so two instances can
 * never overwrite a newer gap or alert twice for one gap. The alert claim, the
 * error row and the webhook commit together: a failed write rolls the claim
 * back, and the next tick alerts again.
 */
export async function applyObservationGap(
	head: ObservedHead,
	unobservedCause: UnobservedCause | null,
	now: Date,
	database: ObservationGapDatabase = prisma,
): Promise<ObservationGapDecision> {
	const decision = decideObservationGap(
		head,
		unobservedCause === null,
		now,
		observationGraceMs(head.contestationPeriod),
	);
	const gapSince = head.observationGapSince;
	const readState = { id: head.id, observationGapSince: gapSince };
	switch (decision) {
		case 'clear':
			await database.hydraHead.updateMany({
				where: readState,
				data: { observationGapSince: null, observationGapAlertedAt: null, observationCheckedAt: null },
			});
			return decision;
		case 'record':
			// Not checked for a while: an outage of this service or a slow tick.
			if (gapSince !== null) {
				logger.warn('[HydraContestWatch] restarting a stale observation gap', {
					hydraHeadId: head.id,
					observationGapSince: gapSince.toISOString(),
					observationCheckedAt: head.observationCheckedAt?.toISOString() ?? null,
				});
			}
			await database.hydraHead.updateMany({
				where: readState,
				data: { observationGapSince: now, observationGapAlertedAt: null, observationCheckedAt: now },
			});
			return decision;
		case 'touch':
			await database.hydraHead.updateMany({ where: readState, data: { observationCheckedAt: now } });
			return decision;
		case 'alert': {
			if (gapSince === null || unobservedCause === null) return 'unchanged';
			const advice = unobservedCause.isNodeSide ? NODE_SIDE_ADVICE : SERVICE_SIDE_ADVICE;
			const isAnnounced = await database.$transaction(async (tx) => {
				const claimed = await tx.hydraHead.updateMany({
					where: { ...readState, observationGapAlertedAt: null },
					data: { observationGapAlertedAt: now, observationCheckedAt: now },
				});
				if (claimed.count !== 1) return false;
				await tx.hydraHeadError.create({
					data: {
						hydraHeadId: head.id,
						errorType: HydraErrorType.HeadUnobserved,
						errorMessage: `This service has not been able to observe the node for this head since ${gapSince.toISOString()}. At the last check, ${unobservedCause.reason}. ${advice}`,
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
					reason: unobservedCause.reason,
					isNodeSide: unobservedCause.isNodeSide,
					checkedAt: now.toISOString(),
				});
				return true;
			});
			if (!isAnnounced) return 'unchanged';
			logger.warn('[HydraContestWatch] the head node has not been observed for the grace period', {
				hydraHeadId: head.id,
				headStatus: head.status,
				unobservedSince: gapSince.toISOString(),
				reason: unobservedCause.reason,
				isNodeSide: unobservedCause.isNodeSide,
			});
			return decision;
		}
		case 'unchanged':
			return decision;
	}
}
