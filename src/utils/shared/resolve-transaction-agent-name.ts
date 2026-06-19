import { prisma } from '@masumi/payment-core/db';
import type { Prisma } from '@/generated/prisma/client';

const MAX_AGENT_NAME_LENGTH = 250;

function normalizeAgentName(name: string | null | undefined): string | null {
	const trimmed = name?.trim();
	if (!trimmed) return null;
	return trimmed.length > MAX_AGENT_NAME_LENGTH ? trimmed.slice(0, MAX_AGENT_NAME_LENGTH) : trimmed;
}

export async function lookupAgentNameFromRegistry(
	agentIdentifier: string | null | undefined,
	db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<string | null> {
	if (!agentIdentifier?.trim()) return null;

	const entry = await db.registryRequest.findFirst({
		where: { agentIdentifier },
		select: { name: true },
	});

	return normalizeAgentName(entry?.name);
}

export async function resolveTransactionAgentName(options: {
	agentIdentifier: string | null | undefined;
	onChainName?: string | null | undefined;
	db?: Prisma.TransactionClient | typeof prisma;
}): Promise<string | null> {
	const fromRegistry = await lookupAgentNameFromRegistry(options.agentIdentifier, options.db);
	if (fromRegistry) return fromRegistry;
	return normalizeAgentName(options.onChainName);
}

export async function lookupAgentNamesByIdentifiers(
	agentIdentifiers: string[],
	db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<Map<string, string>> {
	const unique = [...new Set(agentIdentifiers.map((id) => id.trim()).filter(Boolean))];
	const map = new Map<string, string>();
	if (unique.length === 0) return map;

	const entries = await db.registryRequest.findMany({
		where: { agentIdentifier: { in: unique } },
		select: { agentIdentifier: true, name: true },
		orderBy: { updatedAt: 'desc' },
	});

	for (const entry of entries) {
		if (!entry.agentIdentifier) continue;
		const name = normalizeAgentName(entry.name);
		if (name && !map.has(entry.agentIdentifier)) {
			map.set(entry.agentIdentifier, name);
		}
	}

	return map;
}
