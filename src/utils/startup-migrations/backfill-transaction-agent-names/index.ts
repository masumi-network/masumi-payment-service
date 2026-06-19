import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import type { Network } from '@/generated/prisma/client';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { lookupAgentNameFromOnChainMetadata } from '@/services/integrations/asset-metadata';
import { lookupAgentNameFromRegistry } from '@/utils/shared/resolve-transaction-agent-name';

const BATCH = 250;

type PaymentSourceRpc = {
	network: Network;
	rpcProviderApiKey: string;
};

/**
 * Idempotent startup migration: fills `agentName` (and `agentNameSyncedAt`) for legacy rows.
 * Resolves names from on-chain metadata first (covers external agents on purchases), then registry.
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

	const paymentSources = await prisma.paymentSource.findMany({
		where: { deletedAt: null },
		select: {
			id: true,
			network: true,
			PaymentSourceConfig: { select: { rpcProviderApiKey: true } },
		},
	});
	const sourceById = new Map<string, PaymentSourceRpc>(
		paymentSources.map((ps) => [
			ps.id,
			{ network: ps.network, rpcProviderApiKey: ps.PaymentSourceConfig.rpcProviderApiKey },
		]),
	);

	const nameCache = new Map<string, string | null>();

	const resolveName = async (paymentSourceId: string, agentIdentifier: string | null): Promise<string | null> => {
		if (!agentIdentifier) {
			return null;
		}

		const cacheKey = `${paymentSourceId}:${agentIdentifier}`;
		if (nameCache.has(cacheKey)) {
			return nameCache.get(cacheKey) ?? null;
		}

		let name: string | null = null;
		const source = sourceById.get(paymentSourceId);
		if (source) {
			const blockfrost = getBlockfrostInstance(source.network, source.rpcProviderApiKey);
			name = await lookupAgentNameFromOnChainMetadata(blockfrost, agentIdentifier);
		}
		if (!name) {
			name = await lookupAgentNameFromRegistry(agentIdentifier);
		}

		nameCache.set(cacheKey, name);
		return name;
	};

	let paymentsDone = 0;
	let purchasesDone = 0;
	const syncedAt = new Date();

	for (;;) {
		const chunk = await prisma.paymentRequest.findMany({
			where: { agentNameSyncedAt: null },
			select: { id: true, agentIdentifier: true, paymentSourceId: true },
			take: BATCH,
			orderBy: { createdAt: 'asc' },
		});
		if (chunk.length === 0) break;

		for (const row of chunk) {
			const agentName = await resolveName(row.paymentSourceId, row.agentIdentifier);
			await prisma.paymentRequest.update({
				where: { id: row.id },
				data: { agentName, agentNameSyncedAt: syncedAt },
			});
		}
		paymentsDone += chunk.length;
	}

	for (;;) {
		const chunk = await prisma.purchaseRequest.findMany({
			where: { agentNameSyncedAt: null },
			select: { id: true, agentIdentifier: true, paymentSourceId: true },
			take: BATCH,
			orderBy: { createdAt: 'asc' },
		});
		if (chunk.length === 0) break;

		for (const row of chunk) {
			const agentName = await resolveName(row.paymentSourceId, row.agentIdentifier);
			await prisma.purchaseRequest.update({
				where: { id: row.id },
				data: { agentName, agentNameSyncedAt: syncedAt },
			});
		}
		purchasesDone += chunk.length;
	}

	logger.info('Transaction agentName backfill complete', {
		component: 'migration',
		paymentsDone,
		purchasesDone,
	});
}
