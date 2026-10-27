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
import {
	applyObservationGap,
	nodeUnobservedCause,
	OBSERVATION_STALE_MS,
	type ObservationGapDecision,
	type UnobservedCause,
} from './observation-gap';
import {
	ContestObserverConfigurationError,
	readOnlyContestNode,
	releaseUnusedContestObservers,
} from './read-only-observer';
import { observeHydraHeadIsOpenOnChain, type HydraHeadChainState } from '@/lib/hydra/hydra/head-init-validation';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { mapWithConcurrency } from '@/utils/map-with-concurrency';

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
	isNodeOutagePending: boolean,
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
		now.getTime() - head.contestWatchIssueSince.getTime() < watchUnavailableAfterMs(head.contestationPeriod) ||
		// Left unclaimed, so it still alerts if the unobserved gap starts over first.
		(issue === 'NODE_UNOBSERVABLE' && isNodeOutagePending)
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
			headIdentifier: true,
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
		},
	});
	const connectionManager = getHydraConnectionManager();
	const needsReadOnlyObserver = new Set<string>();
	// Bound Blockfrost calls while continuing past each unavailable observer.
	await mapWithConcurrency(
		heads,
		CONTEST_WATCH_CONCURRENCY,
		async (head) => {
			const now = new Date();
			let chain: ChainObservation | null = null;
			try {
				const apiKey = head.HydraRelation.LocalHotWallet.PaymentSource.PaymentSourceConfig?.rpcProviderApiKey;
				if (!head.headIdentifier || !apiKey) throw new Error('Independent L1 observer is not configured');
				chain = await observeHydraHeadIsOpenOnChain({
					observer: getBlockfrostInstance(head.HydraRelation.network, apiKey),
					headId: head.headIdentifier,
				});
			} catch (error) {
				logger.warn('[HydraContestWatch] independent L1 observation failed', {
					hydraHeadId: head.id,
					error: error instanceof Error ? error.message : 'Unknown error',
				});
			}
			let node: HydraNode | null = null;
			let unobservedCause: UnobservedCause | null;
			let isNodeObservable = false;
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
			let observationDecision: ObservationGapDecision | null = null;
			try {
				observationDecision = await applyObservationGap(head, unobservedCause, now);
			} catch (error) {
				logger.warn('[HydraContestWatch] could not record whether the head node is observed', {
					hydraHeadId: head.id,
					error: error instanceof Error ? error.message : 'Unknown error',
				});
			}
			try {
				// Durable status may still say Open after a lifecycle write failed.
				// Use the pinned node's observed close status, never that stale row.
				// A closed socket keeps its last status but loses its authenticated sessions.
				if (node?.hasVerifiedPinnedSessions && node.status === HydraHeadStatus.Open && chain?.state !== 'closed') {
					isNodeObservable = true;
				} else if (node?.hasVerifiedPinnedSessions && node.status === HydraHeadStatus.FanningOut) {
					isNodeObservable = true;
				} else if (
					node &&
					(node.status === HydraHeadStatus.Closed || node.status === HydraHeadStatus.FanoutPossible) &&
					chain?.state !== 'open'
				) {
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
					if (closedSnapshotNumber !== undefined && verifiedSnapshotNumber !== undefined) {
						isNodeObservable = true;
						await applyContestGapObservation(
							head,
							{ status: node.status, closedSnapshotNumber, verifiedSnapshotNumber },
							now,
						);
					}
				}
			} catch (error) {
				logger.warn('[HydraContestWatch] could not compare the head with the chain', {
					hydraHeadId: head.id,
					error: error instanceof Error ? error.message : 'Unknown error',
				});
			}
			if (chain?.state !== 'gone') {
				// One outage, one alert. A node this service cannot observe is
				// HYDRA_HEAD_UNOBSERVED's to alert while that gap is live and started no
				// later than this issue: hold this one until it goes out, then drop it,
				// so a node that comes back in a state L1 contradicts starts a new clock.
				// A gap that started over since (a cause that flips while the node stays
				// not comparable, or a restart) may not reach its grace period first, so
				// this alert stays the backstop.
				const nodeIssueSince =
					head.contestWatchIssueSignature === 'NODE_UNOBSERVABLE' ? head.contestWatchIssueSince : null;
				const isNodeOutageUnobserved =
					unobservedCause !== null &&
					head.observationGapSince !== null &&
					head.observationCheckedAt !== null &&
					now.getTime() - head.observationCheckedAt.getTime() < OBSERVATION_STALE_MS &&
					(nodeIssueSince === null || head.observationGapSince.getTime() <= nodeIssueSince.getTime());
				const isNodeOutageAlerted =
					isNodeOutageUnobserved &&
					(head.observationGapAlertedAt !== null ||
						observationDecision === 'alert' ||
						observationDecision === 'escalate');
				const issue: WatchIssue | null = !isNodeObservable
					? isNodeOutageAlerted
						? null
						: 'NODE_UNOBSERVABLE'
					: chain === null
						? 'L1_OBSERVER_UNAVAILABLE'
						: null;
				try {
					await applyIndependentContestWatchAlerts(head, chain, issue, now, isNodeOutageUnobserved);
				} catch (error) {
					logger.error('[HydraContestWatch] could not record independent contest alert', {
						hydraHeadId: head.id,
						error: error instanceof Error ? error.message : 'Unknown error',
					});
				}
			}
		},
		(error, head) => {
			logger.error('[HydraContestWatch] head observation failed', {
				hydraHeadId: head.id,
				error: error instanceof Error ? error.message : 'Unknown error',
			});
		},
	);
	await releaseUnusedContestObservers(needsReadOnlyObserver);
}
