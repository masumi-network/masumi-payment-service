/**
 * The durable side of a head's lifecycle: persisting authenticated status
 * frames, naming the close transaction, and failing the head closed when
 * persistence itself breaks.
 *
 * Every write here is fenced on the attachment's `ownerEpoch` (see ADR-0014):
 * the compare-and-set carries the epoch the transport was acquired under, so a
 * stale session's late write misses instead of clobbering — and, critically,
 * instead of durably disabling — a head a newer session owns. On an epoch
 * mismatch the session self-demotes through `onStaleOwner` and touches nothing
 * durable. In a single-instance deployment the fence never fires (the status
 * queue is drained before a head is ever re-acquired); it exists so the write
 * path is already safe when a second instance shows up.
 */

import { prisma } from '@masumi/payment-core/db';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { logger } from '@masumi/payment-core/logger';
import { HydraHeadStatus } from '@/generated/prisma/client';
import { HydraHeadUpdateInput } from '@/generated/prisma/models';
import { CustomHydraHead, StatusChangeData } from '@/lib/hydra';
import { HydraNode } from '@/lib/hydra/hydra/node';
import { HYDRA_HEAD_STATUS_RANK } from './head-status-rank';
import { persistRegressiveHeadStatus } from './head-session-ops';

/**
 * What the persistence pipeline needs from the session/registry it serves.
 * Everything is scoped to one head; the connection manager binds these to the
 * head's session when wiring event handlers.
 */
export interface HeadStatusPersistenceHost {
	/** Fence this head's evidence locally, before any durable write is tried. */
	quarantine(failedHead: CustomHydraHead): void;
	/** Clear the fence once a different transport re-observes durably. */
	clearQuarantineAfterReobservation(observingHead: CustomHydraHead): void;
	/** Tear down and re-read durable enablement (fire-and-forget). */
	scheduleRecovery(): void;
	/**
	 * A newer session owns this head durably. Tear down this transport without
	 * disabling the head, then reconcile against durable enablement — never
	 * quarantine or fail closed, because the head itself is healthy.
	 */
	onStaleOwner(): void;
}

export async function persistHeadStatus(
	host: HeadStatusPersistenceHost,
	hydraHeadId: string,
	head: CustomHydraHead,
	ownerEpoch: bigint,
	data: StatusChangeData,
): Promise<void> {
	const { status, headId, contestationDeadline, snapshotNumber } = data;
	logger.info(`[HydraConnectionManager] Head ${hydraHeadId} status changed to ${status}`, {
		headId,
		contestationDeadline,
		snapshotNumber,
	});
	try {
		if (headId && !/^[0-9a-f]{56}$/.test(headId)) {
			logger.error('[HydraConnectionManager] Rejected a non-canonical Hydra head identifier', {
				hydraHeadId,
			});
			return;
		}
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const current = await prisma.hydraHead.findUnique({
				where: { id: hydraHeadId },
				select: {
					isEnabled: true,
					status: true,
					hydraRelationId: true,
					headIdentifier: true,
					openedAt: true,
					closedAt: true,
					finalizedAt: true,
					contestationDeadline: true,
					latestSnapshotNumber: true,
					ownerEpoch: true,
				},
			});
			if (!current) return;
			if (current.ownerEpoch !== ownerEpoch) {
				logger.warn('[HydraConnectionManager] Refusing a status write from a superseded head session', {
					hydraHeadId,
					sessionOwnerEpoch: ownerEpoch.toString(),
					durableOwnerEpoch: current.ownerEpoch.toString(),
				});
				host.onStaleOwner();
				return;
			}
			if (current.isEnabled === false && HYDRA_HEAD_STATUS_RANK[status] >= HYDRA_HEAD_STATUS_RANK[current.status]) {
				return;
			}
			if (headId && current.headIdentifier != null && current.headIdentifier !== headId) {
				logger.error('[HydraConnectionManager] Rejected a Hydra status frame for a different durable head', {
					hydraHeadId,
				});
				return;
			}
			if (HYDRA_HEAD_STATUS_RANK[status] < HYDRA_HEAD_STATUS_RANK[current.status]) {
				const rollbackResult = await persistRegressiveHeadStatus(
					hydraHeadId,
					current.hydraRelationId,
					status,
					headId,
					snapshotNumber,
					ownerEpoch,
				);
				if (rollbackResult === 'not-regressive') continue;
				if (rollbackResult === 'stale-owner') {
					host.onStaleOwner();
					return;
				}
				if (rollbackResult !== 'ignored') {
					host.clearQuarantineAfterReobservation(head);
				}
				if (rollbackResult === 'persisted') {
					logger.warn('[HydraConnectionManager] Persisted authenticated live Hydra lifecycle rollback', {
						hydraHeadId,
						currentStatus: current.status,
						observedStatus: status,
					});
				}
				if (rollbackResult === 'quarantined-relation-conflict') {
					logger.error(
						'[HydraConnectionManager] Quarantined relation after rollback conflicted with replacement head',
						{
							hydraHeadId,
							hydraRelationId: current.hydraRelationId,
							currentStatus: current.status,
							observedStatus: status,
						},
					);
				}
				if (rollbackResult === 'quarantined-confirmed-finality-conflict') {
					logger.error(
						'[HydraConnectionManager] Quarantined relation after live status contradicted confirmed fanout',
						{
							hydraHeadId,
							hydraRelationId: current.hydraRelationId,
							currentStatus: current.status,
							observedStatus: status,
						},
					);
				}
				return;
			}
			const now = new Date();
			const updateData: HydraHeadUpdateInput = { status, latestActivityAt: now };
			/** Set when this frame is the one that moves the head into Closed. */
			let isClosingTransition = false;
			if (HYDRA_HEAD_STATUS_RANK[status] >= HYDRA_HEAD_STATUS_RANK[HydraHeadStatus.Closed]) {
				// A peer can close the head without using this process's API. Persist the
				// admission gate from the authenticated lifecycle frame as well.
				updateData.isClosing = true;
			}
			if (headId) updateData.headIdentifier = headId;
			if (contestationDeadline && current.contestationDeadline == null) {
				// Field-level parse guard (like the head-id regex above): the schema only
				// bounds the string's length, so `new Date(garbage)` yields Invalid Date,
				// the Prisma write throws, and the catch below would fail-closed the WHOLE
				// head (durably disabled + InitTx attestation wiped) over one cosmetic
				// field from a buggy node build. Skip the field instead of nuking the head.
				const parsedDeadline = new Date(contestationDeadline);
				if (Number.isFinite(parsedDeadline.getTime())) {
					updateData.contestationDeadline = parsedDeadline;
				} else {
					logger.warn('[HydraConnectionManager] Ignoring unparseable contestationDeadline in status frame', {
						hydraHeadId,
						contestationDeadline,
					});
				}
			}
			if (snapshotNumber != null && BigInt(snapshotNumber) > current.latestSnapshotNumber) {
				updateData.latestSnapshotNumber = BigInt(snapshotNumber);
			}
			if (status === HydraHeadStatus.Open && current.openedAt == null) updateData.openedAt = now;
			else if (status === HydraHeadStatus.Closed && current.closedAt == null) {
				updateData.closedAt = now;
				// Deliberately not fetched here. The write below is a compare-and-set
				// against the status read above, and a failed CAS fails the head
				// closed — so an HTTP round trip inside that window trades a real
				// outage risk for a cosmetic field. Captured after the CAS instead.
				isClosingTransition = true;
			} else if (status === HydraHeadStatus.Final && current.finalizedAt == null) updateData.finalizedAt = now;

			const updated = await prisma.hydraHead.updateMany({
				where: {
					id: hydraHeadId,
					isEnabled: true,
					status: current.status,
					headIdentifier: current.headIdentifier,
					ownerEpoch,
				},
				data: updateData,
			});
			if (updated.count === 1) {
				host.clearQuarantineAfterReobservation(head);
				// Only now may HydraNode drain history buffered before identity was
				// known: the exact head id is durably committed by the CAS above.
				if (headId) head.mainNode.pinExpectedHeadId(headId);
				// Awaited, not fired and forgotten. Close happens once per head, so
				// the cost is a single bounded round trip in a head's lifetime, and
				// awaiting keeps it ordered, testable and free of a floating promise.
				if (isClosingTransition) await recordCloseTransaction(hydraHeadId, head.mainNode, ownerEpoch);
				return;
			}
		}
		logger.warn('[HydraConnectionManager] Head status changed concurrently; observed frame retained in logs', {
			hydraHeadId,
			status,
		});
		await failClosedAfterStatusPersistenceFailure(host, hydraHeadId, head, ownerEpoch);
	} catch (error) {
		logger.error('[HydraConnectionManager] Failed to update head status', { hydraHeadId, error });
		await failClosedAfterStatusPersistenceFailure(host, hydraHeadId, head, ownerEpoch);
	}
}

export async function failClosedAfterStatusPersistenceFailure(
	host: HeadStatusPersistenceHost,
	hydraHeadId: string,
	failedHead: CustomHydraHead,
	ownerEpoch: bigint,
): Promise<void> {
	// A missed rollback below Open would otherwise leave stale init evidence
	// available to L2 sync/submission. Block local access immediately, then
	// durably disable the head when the database still accepts a simple write.
	// Recovery is queued without awaiting it so status work cannot deadlock on
	// disconnect's flush of that same queue.
	host.quarantine(failedHead);
	try {
		const disabled = await retryOnSerializationConflict(
			async () =>
				await prisma.hydraHead.updateMany({
					// Fenced: a stale session must never durably disable a head a newer
					// session owns. Its local quarantine and teardown are enough.
					where: { id: hydraHeadId, ownerEpoch },
					data: {
						isEnabled: false,
						initTxHash: null,
						initChainSlot: null,
						initChainHash: null,
						reconciliationCompletedAt: null,
					},
				}),
			{ label: 'hydra-status-persistence-fail-closed' },
		);
		if (disabled.count === 0) {
			logger.warn('[HydraConnectionManager] Skipped durable quarantine: head row gone or owned by a newer session', {
				hydraHeadId,
				sessionOwnerEpoch: ownerEpoch.toString(),
			});
		}
	} catch (quarantineError) {
		logger.error('[HydraConnectionManager] Failed to durably quarantine head after status persistence error', {
			hydraHeadId,
			quarantineError,
		});
	} finally {
		// Start recovery only after the durable quarantine attempt settles. If
		// it ran earlier, a fast disconnect/re-read could reconnect and clear
		// the local fence before the successful disable write became visible.
		host.scheduleRecovery();
	}
}

/**
 * Name the transaction that closed a head, once the close is durable.
 *
 * `HeadIsClosed` carries no transaction id, so this reads the head's own
 * state output from the node — which right now is the close transaction's
 * output, and becomes a fanout step's output as soon as fanout starts. Run
 * only on the transition, never as a backfill: after fanout begins the same
 * read would confidently record the wrong transaction.
 *
 * Failures are swallowed. This names a transaction for operators, and a head
 * whose close cannot be named is still closed.
 */
export async function recordCloseTransaction(hydraHeadId: string, node: HydraNode, ownerEpoch: bigint): Promise<void> {
	try {
		const closeTxHash = await node.fetchHeadOutputTxId();
		if (!closeTxHash) return;
		// Guarded on null so a rollback that cleared the field, or a racing
		// observer, cannot be overwritten by a late read.
		await prisma.hydraHead.updateMany({
			where: { id: hydraHeadId, closeTxHash: null, ownerEpoch },
			data: { closeTxHash },
		});
	} catch (error) {
		logger.warn('[HydraConnectionManager] Could not record the close transaction', {
			hydraHeadId,
			error: error instanceof Error ? error.message : 'Non-error failure',
		});
	}
}
