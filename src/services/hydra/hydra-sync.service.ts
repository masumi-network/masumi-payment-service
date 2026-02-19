import { logger } from '@/utils/logger';
import { prisma } from '@/utils/db';
import { HydraHeadStatus } from './types';
import { getHydraHead, removeHydraHead } from './hydra-manager';

/**
 * Hydra L2 Sync Service
 *
 * Monitors active Hydra heads and reconciles L2 state with L1:
 *
 * 1. Snapshot tracking — records confirmed snapshots from open heads.
 * 2. Fanout detection — detects when a head is closed and fanned out.
 * 3. Reconciliation — maps L2 transactions back to L1 after fanout.
 *
 * This runs as a periodic background job alongside the L1 cardano-tx-handler.
 */

/**
 * Check all open Hydra heads for new snapshots and status changes.
 *
 * Called periodically by the main polling loop.
 * For each open head:
 *   - Poll the HydraHead instance for the latest snapshot
 *   - If snapshot number increased, record it in HydraSnapshot
 *   - If head status changed to Closed/FanoutPossible/Final, update DB
 *   - If head is Final (fanned out), trigger reconciliation
 */
export async function syncHydraHeads(): Promise<void> {
	const openHeads = await prisma.hydraHead.findMany({
		where: {
			status: { in: ['Open', 'Closed', 'FanoutPossible'] },
		},
		include: { HydraRelation: true },
	});

	if (openHeads.length === 0) return;

	const results = await Promise.allSettled(openHeads.map((head) => syncSingleHead(head.id)));

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

	const currentStatus = instance.status;

	if (currentStatus && (currentStatus as string) !== (dbHead.status as string)) {
		await handleStatusChange(hydraHeadId, currentStatus);
	}

	// TODO: Poll snapshot number from the HydraHead instance
	// and record new snapshots via recordSnapshot()
}

async function handleStatusChange(hydraHeadId: string, newStatus: HydraHeadStatus): Promise<void> {
	logger.info('[HydraSync] Head status changed', { hydraHeadId, newStatus });

	const updateData: Record<string, unknown> = { status: newStatus };

	if (newStatus === HydraHeadStatus.CLOSED) {
		updateData.closedAt = new Date();
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
 * Record a confirmed snapshot for a Hydra head.
 * Called when the HydraHead instance reports a new snapshot number.
 */
export async function recordSnapshot(hydraHeadId: string, snapshotNumber: number, utxoHash?: string): Promise<void> {
	await prisma.hydraSnapshot.upsert({
		where: {
			hydraHeadId_snapshotNumber: { hydraHeadId, snapshotNumber },
		},
		create: { hydraHeadId, snapshotNumber, utxoHash },
		update: { utxoHash },
	});

	await prisma.hydraHead.update({
		where: { id: hydraHeadId },
		data: {
			lastSnapshotNumber: snapshotNumber,
			lastSnapshotUtxoHash: utxoHash,
			lastActivityAt: new Date(),
		},
	});
}

/**
 * Reconcile L2 transactions with L1 after a head fans out.
 *
 * When a Hydra head reaches Final status, the fanout transaction settles
 * the final UTXO set on L1. This function:
 *   1. Finds all L2 transactions associated with this head
 *   2. Marks them as reconciled (the L1 cardano-tx-handler will pick up
 *      the fanout transaction during its normal sync)
 *   3. Records the fanout tx hash on the final snapshot
 *
 * TODO: Implement full reconciliation when @masumi-hydra integration is ready.
 * The fanout tx hash needs to come from the HydraHead instance or L1 sync.
 */
async function reconcileAfterFanout(hydraHeadId: string): Promise<void> {
	logger.info('[HydraSync] Starting fanout reconciliation', { hydraHeadId });

	const l2Transactions = await prisma.transaction.findMany({
		where: { hydraHeadId, layer: 'L2' },
	});

	if (l2Transactions.length === 0) {
		logger.info('[HydraSync] No L2 transactions to reconcile', { hydraHeadId });
		return;
	}

	// TODO: When the fanout tx hash is available from the HydraHead instance:
	// 1. Record it on the final HydraSnapshot
	// 2. Update each L2 Transaction with a reference to the L1 fanout
	// 3. The L1 cardano-tx-handler will detect the fanout tx and update
	//    on-chain state for the associated payment/purchase requests

	logger.info('[HydraSync] Fanout reconciliation pending implementation', {
		hydraHeadId,
		l2TransactionCount: l2Transactions.length,
	});
}
