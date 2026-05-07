import { prisma } from '@/utils/db';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';
import { logger } from '@/utils/logger';

const BATCH = 250;

/**
 * Idempotent startup migration: fills `agentIdentifier` (and `agentIdentifierSyncedAt`) for legacy rows.
 * Uses `agentIdentifierSyncedAt IS NULL` as the pending marker so rows with no agent in the blockchain id
 * (decoded null) are not rescanned on every boot.
 */
export async function backfillTransactionAgentIdentifiers(): Promise<void> {
	const paymentPending = await prisma.paymentRequest.count({
		where: { agentIdentifierSyncedAt: null },
	});
	const purchasePending = await prisma.purchaseRequest.count({
		where: { agentIdentifierSyncedAt: null },
	});
	const pending = paymentPending + purchasePending;
	if (pending === 0) {
		return;
	}

	logger.info('Backfilling agentIdentifier from blockchainIdentifier on legacy transactions', {
		component: 'migration',
		paymentPending,
		purchasePending,
	});

	let paymentsDone = 0;
	let purchasesDone = 0;
	const syncedAt = new Date();

	for (;;) {
		const chunk = await prisma.paymentRequest.findMany({
			where: { agentIdentifierSyncedAt: null },
			select: { id: true, blockchainIdentifier: true },
			take: BATCH,
			orderBy: { createdAt: 'asc' },
		});
		if (chunk.length === 0) break;

		for (const row of chunk) {
			const decoded = decodeBlockchainIdentifier(row.blockchainIdentifier);
			const agentIdentifier = decoded?.agentIdentifier ?? null;
			await prisma.paymentRequest.update({
				where: { id: row.id },
				data: { agentIdentifier, agentIdentifierSyncedAt: syncedAt },
			});
			paymentsDone += 1;
		}
	}

	for (;;) {
		const chunk = await prisma.purchaseRequest.findMany({
			where: { agentIdentifierSyncedAt: null },
			select: { id: true, blockchainIdentifier: true },
			take: BATCH,
			orderBy: { createdAt: 'asc' },
		});
		if (chunk.length === 0) break;

		for (const row of chunk) {
			const decoded = decodeBlockchainIdentifier(row.blockchainIdentifier);
			const agentIdentifier = decoded?.agentIdentifier ?? null;
			await prisma.purchaseRequest.update({
				where: { id: row.id },
				data: { agentIdentifier, agentIdentifierSyncedAt: syncedAt },
			});
			purchasesDone += 1;
		}
	}

	logger.info('Transaction agentIdentifier backfill complete', {
		component: 'migration',
		paymentsDone,
		purchasesDone,
	});
}
