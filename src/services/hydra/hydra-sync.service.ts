import { logger } from '@/utils/logger';
import { prisma } from '@/utils/db';
import { HydraHeadStatus } from './types';
import { getHydraHead, removeHydraHead } from './hydra-manager';

/**
 * Hydra L2 Sync Service
 *
 * Monitors active Hydra heads and reconciles L2 state with L1:
 *
 * 1. Status tracking — detects head status changes and updates DB.
 * 2. Snapshot tracking — updates lastSnapshotNumber on the HydraHead record.
 * 3. Fanout detection — detects when a head reaches Final and triggers reconciliation.
 *
 * Snapshot history is NOT stored in the DB (too high volume). Only the latest
 * snapshot number and UTXO hash are tracked on the HydraHead record.
 * Full snapshot history can be queried from the Hydra node API on demand.
 *
 * This runs as a periodic background job alongside the L1 cardano-tx-handler.
 */

/**
 * Check all active Hydra heads for status changes.
 *
 * Called periodically by the main polling loop.
 * For each active head:
 *   - Compare the live instance status with the DB status
 *   - If status changed, update DB and handle lifecycle transitions
 *   - If head is Final (fanned out), trigger reconciliation
 */
export async function syncHydraHeads(): Promise<void> {
	const activeHeads = await prisma.hydraHead.findMany({
		where: {
			status: { in: ['Open', 'Closed', 'FanoutPossible'] },
		},
		include: { HydraRelation: true },
	});

	if (activeHeads.length === 0) return;

	const results = await Promise.allSettled(activeHeads.map((head) => syncSingleHead(head.id)));

	const failures = results.filter((r) => r.status === 'rejected');
	if (failures.length > 0) {
		logger.error('[HydraSync] Some heads failed to sync', {
			failureCount: failures.length,
		});
	}
}

async function syncSingleHead(hydraHeadId: string): Promise<void> {
	const instance = getHydraHead(hydraHeadId);
	if (!instance) {
		logger.debug('[HydraSync] No live instance for head, skipping', { hydraHeadId });
		return;
	}

	const dbHead = await prisma.hydraHead.findUnique({
		where: { id: hydraHeadId },
	});
	if (!dbHead) return;

	const currentStatus = instance.status as string;
	const dbStatus = dbHead.status as string;

	if (currentStatus !== dbStatus) {
		await handleStatusChange(hydraHeadId, instance.status);
	}
}

async function handleStatusChange(hydraHeadId: string, newStatus: HydraHeadStatus): Promise<void> {
	logger.info('[HydraSync] Head status changed', { hydraHeadId, newStatus });

	const updateData: Record<string, unknown> = { status: newStatus };

	if (newStatus === HydraHeadStatus.OPEN) {
		updateData.openedAt = new Date();
	} else if (newStatus === HydraHeadStatus.CLOSED) {
		updateData.closedAt = new Date();
		const head = await prisma.hydraHead.findUnique({
			where: { id: hydraHeadId },
			select: { contestationPeriod: true },
		});
		if (head) {
			updateData.contestationDeadline = new Date(Date.now() + head.contestationPeriod * 1000);
		}
	} else if (newStatus === HydraHeadStatus.FINAL) {
		updateData.finalizedAt = new Date();
	}

	await prisma.hydraHead.update({
		where: { id: hydraHeadId },
		data: updateData,
	});

	if (newStatus === HydraHeadStatus.FINAL) {
		await reconcileAfterFanout(hydraHeadId);
		removeHydraHead(hydraHeadId);
	}
}

/**
 * Update the latest snapshot state on a Hydra head record.
 *
 * Called when the HydraHead instance reports a new confirmed snapshot.
 * Only the snapshot number is stored — no historical snapshot records
 * are persisted. The Hydra node retains full snapshot state.
 */
export async function updateSnapshot(hydraHeadId: string, snapshotNumber: number): Promise<void> {
	await prisma.hydraHead.update({
		where: { id: hydraHeadId },
		data: {
			latestSnapshotNumber: snapshotNumber,
			latestActivityAt: new Date(),
		},
	});
}

/**
 * Reconcile L2 transactions with L1 after a head fans out.
 *
 * When a Hydra head reaches Final status, the fanout transaction settles
 * the final UTXOs set on L1. The L1 cardano-tx-handler will detect the
 * fanout tx during its normal sync and update on-chain state accordingly.
 */
async function reconcileAfterFanout(hydraHeadId: string): Promise<void> {
	logger.info('[HydraSync] Starting fanout reconciliation', { hydraHeadId });

	const l2TransactionCount = await prisma.transaction.count({
		where: { hydraHeadId, layer: 'L2' },
	});

	const head = await prisma.hydraHead.findUnique({
		where: { id: hydraHeadId },
		select: { fanoutTxHash: true },
	});

	logger.info('[HydraSync] Fanout reconciliation completed', {
		hydraHeadId,
		l2TransactionCount,
		fanoutTxHash: String(head?.fanoutTxHash ?? 'pending'),
	});
}
