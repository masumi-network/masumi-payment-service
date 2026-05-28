import { prisma } from '@masumi/payment-core/db';
import { decodeBlockchainIdentifier } from '@masumi/payment-core/blockchain-identifier';
import { logger } from '@masumi/payment-core/logger';

const BATCH = 250;

/**
 * Safely decode one row's blockchainIdentifier. Logs and returns null on any
 * decode error so the caller can still stamp `agentIdentifierSyncedAt` and
 * avoid re-processing this row on every subsequent boot.
 *
 * Without this guard a single malformed `blockchainIdentifier` would throw
 * inside the per-batch `$transaction` callback, abort the whole batch, and —
 * because the startup migration is awaited from `initialize()` (src/app.ts) —
 * crash the boot in a loop on every restart.
 */
function safeDecodeAgentIdentifier(row: { id: string; blockchainIdentifier: string }, table: string): string | null {
	try {
		return decodeBlockchainIdentifier(row.blockchainIdentifier)?.agentIdentifier ?? null;
	} catch (error) {
		logger.warn('backfillTransactionAgentIdentifiers: decode failed for row, stamping null', {
			component: 'migration',
			table,
			rowId: row.id,
			error: error instanceof Error ? { name: error.name, message: error.message } : error,
		});
		return null;
	}
}

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

		await prisma.$transaction(
			async (tx) => {
				for (const row of chunk) {
					const agentIdentifier = safeDecodeAgentIdentifier(row, 'paymentRequest');
					await tx.paymentRequest.update({
						where: { id: row.id },
						data: { agentIdentifier, agentIdentifierSyncedAt: syncedAt },
					});
				}
			},
			{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
		);
		paymentsDone += chunk.length;
	}

	for (;;) {
		const chunk = await prisma.purchaseRequest.findMany({
			where: { agentIdentifierSyncedAt: null },
			select: { id: true, blockchainIdentifier: true },
			take: BATCH,
			orderBy: { createdAt: 'asc' },
		});
		if (chunk.length === 0) break;

		await prisma.$transaction(
			async (tx) => {
				for (const row of chunk) {
					const agentIdentifier = safeDecodeAgentIdentifier(row, 'purchaseRequest');
					await tx.purchaseRequest.update({
						where: { id: row.id },
						data: { agentIdentifier, agentIdentifierSyncedAt: syncedAt },
					});
				}
			},
			{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
		);
		purchasesDone += chunk.length;
	}

	logger.info('Transaction agentIdentifier backfill complete', {
		component: 'migration',
		paymentsDone,
		purchasesDone,
	});
}
