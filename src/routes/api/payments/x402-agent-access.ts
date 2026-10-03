import { Network } from '@/generated/prisma/client';
import createHttpError from 'http-errors';
import { AuthContext } from '@masumi/payment-core/auth';
import { prisma } from '@masumi/payment-core/db';
import { buildManagedHolderWalletScopeFilter } from '@/utils/shared/wallet-scope';

/** Wallet-scoped API keys may only read x402 income/activity for agents they registered. */
export async function assertRegistryAgentInWalletScope(
	ctx: AuthContext,
	network: Network,
	agentIdentifier: string,
): Promise<void> {
	if (ctx.walletScopeIds === null) {
		return;
	}

	const ownedRegistryRequest = await prisma.registryRequest.findFirst({
		where: {
			agentIdentifier,
			PaymentSource: {
				network,
				deletedAt: null,
			},
			SmartContractWallet: {
				deletedAt: null,
			},
			...buildManagedHolderWalletScopeFilter(ctx.walletScopeIds),
		},
		select: { id: true },
	});

	if (ownedRegistryRequest == null) {
		throw createHttpError(404, 'Agent not found');
	}
}
