import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { lookupAgentNamesByIdentifiers } from '@/utils/shared/resolve-transaction-agent-name';

const BATCH = 250;

/**
 * Idempotent startup migration: fills `agentName` (and `agentNameSyncedAt`) for legacy rows.
 * Uses registry `name` when `agentIdentifier` is known; stamps null name when not.
 */
export async function backfillTransactionAgentNames(): Promise<void> {
	const paymentPending = await prisma.paymentRequest.count({
		where: { agentNameSyncedAt: null },
	});
	const purchasePending = await prisma.purchaseRequest.count({
		where: { agentNameSyncedAt: null },
	});
	const pending = paymentPending + purchasePending;
	if (pending === 0) {
		return;
	}

	logger.info('Backfilling agentName on legacy transactions', {
		component: 'migration',
		paymentPending,
		purchasePending,
	});

	let paymentsDone = 0;
	let purchasesDone = 0;
	const syncedAt = new Date();

	for (;;) {
		const chunk = await prisma.paymentRequest.findMany({
			where: { agentNameSyncedAt: null },
			select: { id: true, agentIdentifier: true },
			take: BATCH,
			orderBy: { createdAt: 'asc' },
		});
		if (chunk.length === 0) break;

		await prisma.$transaction(
			async (tx) => {
				const nameByIdentifier = await lookupAgentNamesByIdentifiers(
					chunk.map((row) => row.agentIdentifier).filter((id): id is string => Boolean(id)),
					tx,
				);

				for (const row of chunk) {
					const agentName = row.agentIdentifier ? (nameByIdentifier.get(row.agentIdentifier) ?? null) : null;
					await tx.paymentRequest.update({
						where: { id: row.id },
						data: { agentName, agentNameSyncedAt: syncedAt },
					});
				}
			},
			{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
		);
		paymentsDone += chunk.length;
	}

	for (;;) {
		const chunk = await prisma.purchaseRequest.findMany({
			where: { agentNameSyncedAt: null },
			select: { id: true, agentIdentifier: true },
			take: BATCH,
			orderBy: { createdAt: 'asc' },
		});
		if (chunk.length === 0) break;

		await prisma.$transaction(
			async (tx) => {
				const nameByIdentifier = await lookupAgentNamesByIdentifiers(
					chunk.map((row) => row.agentIdentifier).filter((id): id is string => Boolean(id)),
					tx,
				);

				for (const row of chunk) {
					const agentName = row.agentIdentifier ? (nameByIdentifier.get(row.agentIdentifier) ?? null) : null;
					await tx.purchaseRequest.update({
						where: { id: row.id },
						data: { agentName, agentNameSyncedAt: syncedAt },
					});
				}
			},
			{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
		);
		purchasesDone += chunk.length;
	}

	logger.info('Transaction agentName backfill complete', {
		component: 'migration',
		paymentsDone,
		purchasesDone,
	});
}
