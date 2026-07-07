import { prisma } from '@masumi/payment-core/db';
import type { Prisma } from '@/generated/prisma/client';
import { normalizeAgentName } from '@/utils/shared/agent-name';

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
	/** When true, prefer the supplied on-chain metadata name over the local registry row. */
	preferOnChain?: boolean;
	db?: Prisma.TransactionClient | typeof prisma;
}): Promise<string | null> {
	const onChain = normalizeAgentName(options.onChainName);
	if (options.preferOnChain && onChain) {
		return onChain;
	}
	const fromRegistry = await lookupAgentNameFromRegistry(options.agentIdentifier, options.db);
	if (fromRegistry) return fromRegistry;
	return onChain;
}
