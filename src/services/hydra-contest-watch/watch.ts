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
import { observeHydraHeadIsOpenOnChain, type HydraHeadChainState } from '@/lib/hydra/hydra/head-init-validation';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { mapWithConcurrency } from '@/utils/map-with-concurrency';
import { readOnlyContestNode, releaseUnusedContestObservers } from './read-only-observer';

/** A contest is posted and seen on chain within a few blocks. Two minutes without one is not a slow chain. */
export const CONTEST_GRACE_MS = 2 * 60_000;
const MAX_WATCH_UNAVAILABLE_MS = 5 * 60_000;
const MIN_WATCH_UNAVAILABLE_MS = 60_000;
const WATCH_UNAVAILABLE_PERIOD_DIVISOR = 10n;
const CONTEST_WATCH_CONCURRENCY = 8;

type ChainObservation = { state: HydraHeadChainState; latestTxHash: string };
type WatchIssue = 'NODE_UNOBSERVABLE' | 'L1_OBSERVER_UNAVAILABLE';

type StoredWatchAlert = {
	id: string;
	status: HydraHeadStatus;
	contestationPeriod: bigint;
	contestWatchClosedAlertedAt: Date | null;
	contestWatchIssueSignature: string | null;
	contestWatchIssueSince: Date | null;
	contestWatchIssueAlertedAt: Date | null;
};

/** Alert within ten percent of the configured contest period, never later than five minutes. */
export function watchUnavailableAfterMs(contestationPeriod: bigint): number {
	const periodShareMs = (contestationPeriod * 1000n) / WATCH_UNAVAILABLE_PERIOD_DIVISOR;
	return Number(
		periodShareMs < BigInt(MIN_WATCH_UNAVAILABLE_MS)
			? BigInt(MIN_WATCH_UNAVAILABLE_MS)
			: periodShareMs > BigInt(MAX_WATCH_UNAVAILABLE_MS)
				? BigInt(MAX_WATCH_UNAVAILABLE_MS)
				: periodShareMs,
	);
}

/** Keep the L1 Close and observer outage alerts independent of a signed-snapshot gap. */
async function applyIndependentContestWatchAlerts(
	head: StoredWatchAlert,
	chain: ChainObservation | null,
	issue: WatchIssue | null,
	now: Date,
): Promise<void> {
	if (chain?.state === 'closed' && head.contestWatchClosedAlertedAt === null) {
		await prisma.$transaction(async (tx) => {
			const claimed = await tx.hydraHead.updateMany({
				where: { id: head.id, contestWatchClosedAlertedAt: null },
				data: { contestWatchClosedAlertedAt: now },
			});
			if (claimed.count !== 1) return;
			await webhookEventsService.queueHydraHeadContestWatchAlertInTransaction(tx, {
				hydraHeadId: head.id,
				headStatus: head.status,
				reason: 'HEAD_CLOSED',
				chainState: chain.state,
				chainTxHash: chain.latestTxHash,
				unavailableSince: null,
				checkedAt: now.toISOString(),
			});
		});
	} else if (chain?.state === 'open' && head.contestWatchClosedAlertedAt !== null) {
		// A rollback to Open permits one alert for the next actual Close.
		await prisma.hydraHead.updateMany({
			where: { id: head.id, contestWatchClosedAlertedAt: head.contestWatchClosedAlertedAt },
			data: { contestWatchClosedAlertedAt: null },
		});
	}

	if (issue === null) {
		if (head.contestWatchIssueSignature !== null) {
			await prisma.hydraHead.updateMany({
				where: { id: head.id, contestWatchIssueSignature: head.contestWatchIssueSignature },
				data: { contestWatchIssueSignature: null, contestWatchIssueSince: null, contestWatchIssueAlertedAt: null },
			});
		}
		return;
	}
	if (head.contestWatchIssueSignature !== issue || head.contestWatchIssueSince === null) {
		await prisma.hydraHead.updateMany({
			where: { id: head.id, contestWatchIssueSignature: head.contestWatchIssueSignature },
			data: { contestWatchIssueSignature: issue, contestWatchIssueSince: now, contestWatchIssueAlertedAt: null },
		});
		return;
	}
	if (
		head.contestWatchIssueAlertedAt !== null ||
		now.getTime() - head.contestWatchIssueSince.getTime() < watchUnavailableAfterMs(head.contestationPeriod)
	) {
		return;
	}
	await prisma.$transaction(async (tx) => {
		const claimed = await tx.hydraHead.updateMany({
			where: { id: head.id, contestWatchIssueSignature: issue, contestWatchIssueAlertedAt: null },
			data: { contestWatchIssueAlertedAt: now },
		});
		if (claimed.count !== 1) return;
		await webhookEventsService.queueHydraHeadContestWatchAlertInTransaction(tx, {
			hydraHeadId: head.id,
			headStatus: head.status,
			reason: issue,
			chainState: chain?.state ?? null,
			chainTxHash: chain?.latestTxHash ?? null,
			unavailableSince: head.contestWatchIssueSince!.toISOString(),
			checkedAt: now.toISOString(),
		});
	});
}

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

const watchedHeadSelect = {
	id: true,
	headIdentifier: true,
	status: true,
	isEnabled: true,
	contestGapSignature: true,
	contestGapSince: true,
	contestGapAlertedAt: true,
	contestationPeriod: true,
	contestWatchClosedAlertedAt: true,
	contestWatchIssueSignature: true,
	contestWatchIssueSince: true,
	contestWatchIssueAlertedAt: true,
	HydraRelation: {
		select: {
			network: true,
			LocalHotWallet: {
				select: { PaymentSource: { select: { PaymentSourceConfig: { select: { rpcProviderApiKey: true } } } } },
			},
		},
	},
} satisfies Prisma.HydraHeadSelect;
type WatchedHead = Prisma.HydraHeadGetPayload<{ select: typeof watchedHeadSelect }>;

/** What the node showed. `compared` means the snapshot gap check ran on its numbers. */
type NodeEvidence = 'open' | 'fanningOut' | 'compared' | null;

/**
 * Compare the node's close with its verified snapshot. This uses the node only:
 * an L1 read that lags or fails must never hide or delay a gap.
 */
async function compareHeadWithNode(
	head: WatchedHead,
	connectionManager: ReturnType<typeof getHydraConnectionManager>,
	needsReadOnlyObserver: Set<string>,
): Promise<NodeEvidence> {
	let node = head.isEnabled ? connectionManager.getNode(head.id) : null;
	if (!node) {
		needsReadOnlyObserver.add(head.id);
		node = await readOnlyContestNode(head.id);
	}
	// Durable status may still say Open after a lifecycle write failed.
	// Use the pinned node's observed close status, never that stale row.
	// A closed socket keeps its last status but loses its authenticated sessions.
	if (node.hasVerifiedPinnedSessions && node.status === HydraHeadStatus.Open) return 'open';
	if (node.hasVerifiedPinnedSessions && node.status === HydraHeadStatus.FanningOut) return 'fanningOut';
	if (node.status !== HydraHeadStatus.Closed && node.status !== HydraHeadStatus.FanoutPossible) return null;
	const closedSnapshotNumber = node.closedSnapshotNumber;
	let verifiedSnapshotNumber = node.verifiedSnapshotNumber;
	if (head.headIdentifier) {
		try {
			const stored = await prisma.hydraStoredSnapshot.findFirst({
				where: { hydraHeadId: head.id, headIdentifier: head.headIdentifier },
				orderBy: [{ snapshotNumber: 'desc' }, { snapshotVersion: 'desc' }],
				select: { snapshotNumber: true },
			});
			if (stored && (verifiedSnapshotNumber === undefined || stored.snapshotNumber > verifiedSnapshotNumber)) {
				verifiedSnapshotNumber = stored.snapshotNumber;
			}
		} catch (error) {
			logger.warn('[HydraContestWatch] could not read stored signed snapshot', {
				hydraHeadId: head.id,
				error: error instanceof Error ? error.message : 'Unknown error',
			});
		}
	}
	if (closedSnapshotNumber === undefined || verifiedSnapshotNumber === undefined) return null;
	try {
		await applyContestGapObservation(
			head,
			{ status: node.status, closedSnapshotNumber, verifiedSnapshotNumber },
			new Date(),
		);
	} catch (error) {
		// The node answered. A failed write is retried next tick, and must not read as a lost node.
		logger.error('[HydraContestWatch] could not record the snapshot gap', {
			hydraHeadId: head.id,
			error: error instanceof Error ? error.message : 'Unknown error',
		});
	}
	return 'compared';
}

async function observeHeadOnChain(head: WatchedHead): Promise<ChainObservation | null> {
	try {
		const apiKey = head.HydraRelation.LocalHotWallet.PaymentSource.PaymentSourceConfig?.rpcProviderApiKey;
		if (!head.headIdentifier || !apiKey) throw new Error('Independent L1 observer is not configured');
		return await observeHydraHeadIsOpenOnChain({
			observer: getBlockfrostInstance(head.HydraRelation.network, apiKey),
			headId: head.headIdentifier,
		});
	} catch (error) {
		logger.warn('[HydraContestWatch] independent L1 observation failed', {
			hydraHeadId: head.id,
			error: error instanceof Error ? error.message : 'Unknown error',
		});
		return null;
	}
}

/** Compare authenticated node history even while the payment session is quarantined. */
export async function runHydraContestWatch(): Promise<void> {
	const heads = await prisma.hydraHead.findMany({
		where: {
			status: { in: [HydraHeadStatus.Open, HydraHeadStatus.Closed, HydraHeadStatus.FanoutPossible] },
			retiredAt: null,
			LocalParticipant: { isNot: null },
		},
		select: watchedHeadSelect,
	});
	const connectionManager = getHydraConnectionManager();
	const needsReadOnlyObserver = new Set<string>();
	const nodeEvidence = new Map<string, NodeEvidence>();
	// The gap check runs first and for every head at once: an unavailable node or
	// a slow L1 read must not delay alerts for another head's deadline.
	await Promise.allSettled(
		heads.map(async (head) => {
			try {
				nodeEvidence.set(head.id, await compareHeadWithNode(head, connectionManager, needsReadOnlyObserver));
			} catch (error) {
				logger.warn('[HydraContestWatch] could not read the node', {
					hydraHeadId: head.id,
					error: error instanceof Error ? error.message : 'Unknown error',
				});
			}
		}),
	);
	// Bound Blockfrost calls while continuing past each unavailable observer.
	await mapWithConcurrency(
		heads,
		CONTEST_WATCH_CONCURRENCY,
		async (head) => {
			const now = new Date();
			const chain = await observeHeadOnChain(head);
			if (chain?.state === 'gone') return;
			const evidence = nodeEvidence.get(head.id) ?? null;
			const isNodeObservable =
				evidence === 'compared' || evidence === 'fanningOut' || (evidence === 'open' && chain?.state !== 'closed');
			const issue: WatchIssue | null = !isNodeObservable
				? 'NODE_UNOBSERVABLE'
				: chain === null
					? 'L1_OBSERVER_UNAVAILABLE'
					: null;
			await applyIndependentContestWatchAlerts(head, chain, issue, now);
		},
		(error, head) => {
			logger.error('[HydraContestWatch] could not record independent contest alert', {
				hydraHeadId: head.id,
				error: error instanceof Error ? error.message : 'Unknown error',
			});
		},
	);
	await releaseUnusedContestObservers(needsReadOnlyObserver);
}
