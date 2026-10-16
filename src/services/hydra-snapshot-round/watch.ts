/**
 * Watchdog for a Hydra snapshot round that stopped moving.
 *
 * A round needs every party's signature. When one party can never sign (for
 * example it dropped a transaction the round includes), the round never
 * completes, the leader starts no new one, and the head confirms nothing. Every
 * L2 action then waits forever, and the wallet the stuck transaction reserved
 * stays pinned. The node reports nothing wrong; only `GET /snapshot/last-seen`
 * shows the same round in flight, unchanged.
 *
 * This records the round our node reports, marks it stuck once it has not moved
 * for `SNAPSHOT_ROUND_STUCK_AFTER_MS`, and alerts once per round. Recovery is an
 * admin decision (see `./reset`), never automatic.
 */
import { HydraHeadStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { fetchHydraSnapshotRound, type HydraSnapshotRound } from '@/lib/hydra/hydra/node-control-queries';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { webhookEventsService } from '@/services/webhooks/events.service';

/** A healthy round completes in about a second. Ten minutes unchanged is not a slow peer. */
export const SNAPSHOT_ROUND_STUCK_AFTER_MS = 10 * 60_000;

export type StoredSnapshotRound = {
	snapshotRoundSignature: string | null;
	snapshotRoundSince: Date | null;
	snapshotRoundAlertedAt: Date | null;
};

export type SnapshotRoundDecision =
	/** No round in flight: clear whatever was recorded. */
	| { action: 'clear' }
	/** A round we have not seen before: start its clock. */
	| { action: 'record' }
	/** The same round as last time; nothing to write. */
	| { action: 'unchanged' }
	/** The same round, past the threshold, not yet alerted. */
	| { action: 'alert' };

export function isSnapshotRoundStuck(since: Date | null, now: Date): boolean {
	return since !== null && now.getTime() - since.getTime() >= SNAPSHOT_ROUND_STUCK_AFTER_MS;
}

export function decideSnapshotRound(
	stored: StoredSnapshotRound,
	round: HydraSnapshotRound,
	now: Date,
): SnapshotRoundDecision {
	if (!round.inFlight) {
		return stored.snapshotRoundSignature === null && stored.snapshotRoundSince === null
			? { action: 'unchanged' }
			: { action: 'clear' };
	}
	if (stored.snapshotRoundSignature !== round.signature || stored.snapshotRoundSince === null) {
		return { action: 'record' };
	}
	if (stored.snapshotRoundAlertedAt === null && isSnapshotRoundStuck(stored.snapshotRoundSince, now)) {
		return { action: 'alert' };
	}
	return { action: 'unchanged' };
}

/**
 * Apply one observation. Every write is conditioned on the signature it read,
 * so two instances (or a reset racing this job) can never overwrite a newer
 * observation or alert twice for one round.
 */
export async function applySnapshotRoundObservation(
	head: { id: string } & StoredSnapshotRound,
	round: HydraSnapshotRound,
	now: Date,
	database: Pick<typeof prisma, 'hydraHead'> = prisma,
): Promise<SnapshotRoundDecision['action']> {
	const decision = decideSnapshotRound(head, round, now);
	const readState = { id: head.id, snapshotRoundSignature: head.snapshotRoundSignature };
	switch (decision.action) {
		case 'clear':
			await database.hydraHead.updateMany({
				where: readState,
				data: { snapshotRoundSignature: null, snapshotRoundSince: null, snapshotRoundAlertedAt: null },
			});
			break;
		case 'record':
			await database.hydraHead.updateMany({
				where: readState,
				data: { snapshotRoundSignature: round.signature, snapshotRoundSince: now, snapshotRoundAlertedAt: null },
			});
			break;
		case 'alert': {
			const claimed = await database.hydraHead.updateMany({
				where: { ...readState, snapshotRoundAlertedAt: null },
				data: { snapshotRoundAlertedAt: now },
			});
			if (claimed.count !== 1 || head.snapshotRoundSince === null) return 'unchanged';
			logger.warn('[HydraSnapshotRound] snapshot round has not moved; the head confirms nothing until reset', {
				hydraHeadId: head.id,
				roundTag: round.tag,
				snapshotNumber: round.number,
				signatoryCount: round.signatoryCount,
				txIds: round.txIds,
				stuckSince: head.snapshotRoundSince.toISOString(),
			});
			await webhookEventsService.triggerHydraHeadSnapshotRoundStuck({
				hydraHeadId: head.id,
				roundTag: round.tag,
				snapshotNumber: round.number,
				signatoryCount: round.signatoryCount,
				txIds: round.txIds,
				stuckSince: head.snapshotRoundSince.toISOString(),
				checkedAt: now.toISOString(),
			});
			break;
		}
		case 'unchanged':
			break;
	}
	return decision.action;
}

/** Scheduler entry: observe the round on every open head this instance holds a session for. */
export async function runHydraSnapshotRoundWatch(): Promise<void> {
	const heads = await prisma.hydraHead.findMany({
		where: { status: HydraHeadStatus.Open, isEnabled: true, LocalParticipant: { isNot: null } },
		select: { id: true, snapshotRoundSignature: true, snapshotRoundSince: true, snapshotRoundAlertedAt: true },
	});
	const connectionManager = getHydraConnectionManager();
	for (const head of heads) {
		// Only the instance that owns the head's session reads it; the others skip.
		const node = connectionManager.getNode(head.id);
		if (!node) continue;
		try {
			await applySnapshotRoundObservation(head, await fetchHydraSnapshotRound(node), new Date());
		} catch (error) {
			logger.warn('[HydraSnapshotRound] could not observe the snapshot round', {
				hydraHeadId: head.id,
				error: error instanceof Error ? error.message : 'Unknown error',
			});
		}
	}
}
