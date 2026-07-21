import { prisma } from '@masumi/payment-core/db';
import { HotWalletType, Network, PaymentSourceType, X402EvmWalletType } from '@/generated/prisma/client';
import type { CardanoReadinessInput, X402ReadinessInput } from './service';

export async function loadCardanoReadinessInput(network: Network): Promise<CardanoReadinessInput> {
	const sources = await prisma.paymentSource.findMany({
		where: {
			network,
			deletedAt: null,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
		},
		select: {
			policyId: true,
			smartContractAddress: true,
			requiredAdminSignatures: true,
			disablePaymentAt: true,
			PaymentSourceConfig: { select: { rpcProviderApiKey: true } },
			_count: { select: { AdminWallets: true } },
			HotWallets: {
				where: { deletedAt: null },
				select: { type: true },
			},
		},
	});

	return {
		network,
		sources: sources.map((source) => ({
			policyId: source.policyId,
			smartContractAddress: source.smartContractAddress,
			requiredAdminSignatures: source.requiredAdminSignatures,
			disablePaymentAt: source.disablePaymentAt,
			adminWalletCount: source._count.AdminWallets,
			rpcProviderApiKey: source.PaymentSourceConfig?.rpcProviderApiKey ?? null,
			sellingWalletCount: source.HotWallets.filter((wallet) => wallet.type === HotWalletType.Selling).length,
			purchasingWalletCount: source.HotWallets.filter((wallet) => wallet.type === HotWalletType.Purchasing).length,
		})),
	};
}

export async function loadX402ReadinessInput(network: Network): Promise<X402ReadinessInput> {
	// x402 chains have no Cardano network of their own; they are grouped into an
	// environment purely by isTestnet, matching the admin UI's chainsForEnv.
	const chains = await prisma.x402Network.findMany({
		where: { isTestnet: network === Network.Preprod },
		select: {
			caip2Id: true,
			isEnabled: true,
			rpcUrl: true,
			facilitatorWalletId: true,
			facilitatorUrl: true,
			Wallets: {
				where: { deletedAt: null },
				select: {
					type: true,
					// A budget only enables spending while it is enabled AND still has
					// funds left; a spent-out grant is not a usable budget.
					_count: { select: { Budgets: { where: { enabled: true, remainingAmount: { gt: 0 } } } } },
				},
			},
		},
	});

	return {
		chains: chains.map((chain) => ({
			caip2Id: chain.caip2Id,
			isEnabled: chain.isEnabled,
			rpcUrl: chain.rpcUrl,
			facilitatorWalletId: chain.facilitatorWalletId,
			facilitatorUrl: chain.facilitatorUrl,
			sellingWalletCount: chain.Wallets.filter((wallet) => wallet.type === X402EvmWalletType.Selling).length,
			purchasingWalletCount: chain.Wallets.filter((wallet) => wallet.type === X402EvmWalletType.Purchasing).length,
			// Budgets are attached to purchasing wallets, so only count those.
			fundedBudgetCount: chain.Wallets.filter((wallet) => wallet.type === X402EvmWalletType.Purchasing).reduce(
				(total, wallet) => total + wallet._count.Budgets,
				0,
			),
		})),
	};
}
