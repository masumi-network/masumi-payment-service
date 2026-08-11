/**
 * Two head-session operations that need no session state.
 *
 * Split from the connection manager, which was past the 750-line limit. Both
 * were already methods that touched no field of the class: the regressive
 * persist decides, under the same head-row lock final reconciliation uses,
 * whether a lower-ranked lifecycle frame is a real rollback or a stale echo,
 * and the slot probe opens a short-lived socket to read the head's own clock.
 *
 * Free functions rather than methods precisely because they hold nothing. That
 * is also what made them safe to move out of a stateful class: no field, no
 * sibling call, nothing to rebind.
 */

import { prisma } from '@masumi/payment-core/db';
import { isUniqueConstraintError } from '@masumi/payment-core/db-retry';
import { withSerializableSlotRetry } from '@masumi/payment-core/serializable-semaphore';
import WebSocket, { type RawData } from 'ws';
import { HydraHeadStatus, Prisma } from '@/generated/prisma/client';
import { HydraHeadUpdateInput } from '@/generated/prisma/models';
import { hydraAuthHeaders } from '@/lib/hydra/hydra/auth';
import { getOwnValue, isPlainObject } from '@masumi/payment-core/object-properties';

import { HYDRA_HEAD_STATUS_RANK, type LockedHydraHeadLifecycle, type RegressiveStatusResult } from './head-status-rank';

/**
 * Persist an authenticated live lifecycle rollback while holding the same
 * head-row lock used by final reconciliation. Hydra history replay never
 * emits StatusChange; a lower-ranked frame here therefore describes the
 * local node's current L1 view rather than an old history item.
 */
export async function persistRegressiveHeadStatus(
	hydraHeadId: string,
	hydraRelationId: string,
	status: HydraHeadStatus,
	headId: string | undefined,
	snapshotNumber: number | undefined,
): Promise<RegressiveStatusResult> {
	const persistAttempt = async (): Promise<RegressiveStatusResult> =>
		await prisma.$transaction(
			async (tx) => {
				// Head creation/deletion use the relation as their first lock. Match that
				// order, then lock every sibling in canonical order. The all-head
				// fence matches cleanup/replacement writers and prevents inverse
				// target-head -> sibling-head waits during relation quarantine.
				const relations = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
					SELECT "id" FROM "HydraRelation"
					WHERE "id" = ${hydraRelationId}
					FOR UPDATE
				`);
				if (relations.length !== 1) return 'ignored';
				const rows = await tx.$queryRaw<LockedHydraHeadLifecycle[]>(Prisma.sql`
					SELECT "id", "hydraRelationId", "isEnabled", "status", "headIdentifier", "fanoutTxHash"
					FROM "HydraHead"
					WHERE "hydraRelationId" = ${hydraRelationId}
					ORDER BY "id"
					FOR UPDATE
				`);
				const current = rows.find((row) => row.id === hydraHeadId);
				if (!current) return 'ignored';
				if (headId && current.headIdentifier != null && current.headIdentifier !== headId) return 'ignored';
				if (HYDRA_HEAD_STATUS_RANK[status] >= HYDRA_HEAD_STATUS_RANK[current.status]) {
					return 'not-regressive';
				}
				if (current.fanoutTxHash != null) {
					// The fanout hash is written only after configured L1 confirmation depth,
					// in the same transaction that adopts every surviving request onto L1.
					// That lineage cannot be reconstructed from a contradictory node frame.
					// Preserve it, invalidate cleanup eligibility, and quarantine the entire
					// relation for explicit operator/reorg recovery.
					const quarantined = await tx.hydraHead.updateMany({
						where: {
							id: hydraHeadId,
							isEnabled: current.isEnabled,
							status: current.status,
							headIdentifier: current.headIdentifier,
							fanoutTxHash: current.fanoutTxHash,
						},
						data: {
							isEnabled: false,
							initTxHash: null,
							reconciliationCompletedAt: null,
						},
					});
					if (quarantined.count !== 1) {
						throw new Error('Confirmed Hydra fanout rollback quarantine lost the locked head row');
					}
					await tx.hydraHead.updateMany({
						where: { hydraRelationId, id: { not: hydraHeadId } },
						data: { isEnabled: false, initTxHash: null },
					});
					return 'quarantined-confirmed-finality-conflict';
				}

				const targetRank = HYDRA_HEAD_STATUS_RANK[status];
				const updateData: HydraHeadUpdateInput = {
					status,
					latestActivityAt: new Date(),
				};
				if (snapshotNumber != null) {
					if (!Number.isSafeInteger(snapshotNumber) || snapshotNumber < 0) return 'ignored';
					// Unlike stale history, an authenticated live regression can also roll
					// back the signed snapshot tip. Forward persistence is monotonic, so the
					// lower tip must be written explicitly here or re-finalization wedges.
					updateData.latestSnapshotNumber = BigInt(snapshotNumber);
				}

				if (targetRank < HYDRA_HEAD_STATUS_RANK[HydraHeadStatus.Final]) {
					// A rolled-back fanout invalidates every derived completion/adoption
					// token. Clear request handoffs in this transaction so deletion and
					// L1 adoption can never observe a half-invalidated Final head.
					updateData.finalizedAt = null;
					updateData.fanoutTxHash = null;
					updateData.reconciliationCompletedAt = null;
					const clearHandoff = {
						hydraFanoutHandoffHeadId: null,
						hydraFanoutHandoffTxHash: null,
						hydraFanoutHandoffOutputIndex: null,
					};
					await tx.paymentRequest.updateMany({
						where: { hydraFanoutHandoffHeadId: hydraHeadId },
						data: clearHandoff,
					});
					await tx.purchaseRequest.updateMany({
						where: { hydraFanoutHandoffHeadId: hydraHeadId },
						data: clearHandoff,
					});
				}

				if (targetRank < HYDRA_HEAD_STATUS_RANK[HydraHeadStatus.Closed]) {
					updateData.closedAt = null;
					updateData.closeTxHash = null;
					updateData.contestationDeadline = null;
					updateData.isClosing = false;
				} else {
					updateData.isClosing = true;
				}

				if (targetRank < HYDRA_HEAD_STATUS_RANK[HydraHeadStatus.Open]) {
					// A rollback past Open invalidates the L2 ledger itself. Quarantine the
					// head and discard its replay cursor; explicit re-enable must first
					// perform a fresh independent InitTx attestation.
					updateData.openedAt = null;
					updateData.isEnabled = false;
					updateData.initTxHash = null;
					updateData.lastReconciledSnapshotSequence = null;
					updateData.lastReconciledSnapshotTransactionIndex = null;
					updateData.latestSnapshotNumber = 0n;
				}

				const replacementHead = rows.find((row) => row.id !== hydraHeadId && row.status !== HydraHeadStatus.Final);
				if (replacementHead) {
					// The partial unique index cannot represent both the rolled-back old
					// head and an already-created replacement as non-Final. Preserve the
					// schema invariant, invalidate the false finality markers, and quarantine
					// every head in the relation for explicit operator recovery.
					const invalidated = await tx.hydraHead.updateMany({
						where: {
							id: hydraHeadId,
							isEnabled: current.isEnabled,
							status: current.status,
							headIdentifier: current.headIdentifier,
						},
						data: {
							...updateData,
							status: current.status,
							isEnabled: false,
							initTxHash: null,
						},
					});
					if (invalidated.count !== 1) {
						throw new Error('Hydra rollback invalidation lost ownership of the locked head row');
					}
					await tx.hydraHead.updateMany({
						where: { hydraRelationId, id: { not: hydraHeadId } },
						data: { isEnabled: false, initTxHash: null },
					});
					return 'quarantined-relation-conflict';
				}

				const updated = await tx.hydraHead.updateMany({
					where: {
						id: hydraHeadId,
						isEnabled: current.isEnabled,
						status: current.status,
						headIdentifier: current.headIdentifier,
					},
					data: updateData,
				});
				if (updated.count !== 1) {
					throw new Error('Hydra rollback persistence lost ownership of the locked head row');
				}
				return 'persisted';
			},
			{
				isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
				maxWait: 15_000,
				timeout: 15_000,
			},
		);

	try {
		return await withSerializableSlotRetry(persistAttempt, { label: 'hydra-live-status-rollback' });
	} catch (error) {
		if (!isUniqueConstraintError(error)) throw error;
		// A replacement creator can commit while this Serializable attempt is
		// waiting for the relation lock. PostgreSQL's fixed snapshot may then
		// miss that new row and surface the partial one-active-head index as
		// 23505/P2002. One fresh transaction sees the replacement and takes the
		// explicit relation-quarantine path above.
		return await withSerializableSlotRetry(persistAttempt, {
			label: 'hydra-live-status-rollback-after-replacement',
		});
	}
}

/**
 * Open a short-lived probe socket and read the head's current L1 slot from the
 * Greetings frame the node sends on connect. Returns null if the head does not
 * match, the node is not synced, or the probe times out.
 */
export function probeHeadCurrentSlot(
	wsUrl: string,
	expectedHeadId: string | null,
	authToken?: string,
): Promise<number | null> {
	return new Promise<number | null>((resolve) => {
		let settled = false;
		const finish = (value: number | null) => {
			if (settled) return;
			settled = true;
			try {
				socket.close();
			} catch {
				// ignore
			}
			resolve(value);
		};
		const authHeaders = hydraAuthHeaders(authToken);
		const socket = new WebSocket(`${wsUrl}?history=no`, {
			...(Object.keys(authHeaders).length === 0 ? {} : { headers: authHeaders }),
		});
		const timeout = setTimeout(() => finish(null), 8000);
		timeout.unref?.();
		socket.on('message', (data: RawData) => {
			const text = Buffer.isBuffer(data)
				? data.toString('utf8')
				: Array.isArray(data)
					? Buffer.concat(data).toString('utf8')
					: Buffer.from(data).toString('utf8');
			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch {
				return; // keep waiting for a valid Greetings until the timeout
			}
			if (!isPlainObject(parsed)) return;
			if (getOwnValue(parsed, 'tag') !== 'Greetings') return;
			const headId = getOwnValue(parsed, 'hydraHeadId') ?? getOwnValue(parsed, 'headId');
			if (expectedHeadId != null && headId !== expectedHeadId) return finish(null);
			if (getOwnValue(parsed, 'chainSyncedStatus') !== 'InSync') return finish(null);
			const slot = getOwnValue(parsed, 'currentSlot');
			finish(typeof slot === 'number' && Number.isSafeInteger(slot) && slot >= 0 ? slot : null);
		});
		socket.on('error', () => finish(null));
		socket.on('close', () => finish(null));
	});
}
