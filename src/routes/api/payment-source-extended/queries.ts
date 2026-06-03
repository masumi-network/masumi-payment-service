import { prisma } from '@masumi/payment-core/db';
import { AuthContext } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { paymentSourceExtendedSchemaInput } from './schemas';

export type PaymentSourceExtendedListQueryInput = z.infer<typeof paymentSourceExtendedSchemaInput>;

export const paymentSourceExtendedInclude = {
	AdminWallets: {
		orderBy: { order: 'asc' },
		select: { walletAddress: true, order: true },
	},
	HotWallets: {
		where: { deletedAt: null },
		select: {
			id: true,
			walletVkey: true,
			walletAddress: true,
			type: true,
			collectionAddress: true,
			note: true,
			LowBalanceRules: {
				where: {
					enabled: true,
				},
				select: {
					id: true,
					assetUnit: true,
					thresholdAmount: true,
					enabled: true,
					status: true,
					lastKnownAmount: true,
					lastCheckedAt: true,
					lastAlertedAt: true,
				},
			},
		},
	},
	FeeReceiverNetworkWallet: {
		select: { walletAddress: true },
	},
	PaymentSourceConfig: {
		select: { rpcProviderApiKey: true, rpcProvider: true },
	},
} as const;

export async function getPaymentSourceExtendedForQuery(
	input: PaymentSourceExtendedListQueryInput,
	networkLimit: AuthContext['networkLimit'],
) {
	return prisma.paymentSource.findMany({
		where: {
			network: {
				in: networkLimit,
			},
			deletedAt: null,
		},
		take: input.take,
		orderBy: {
			createdAt: 'desc',
		},
		cursor: input.cursorId ? { id: input.cursorId } : undefined,
		include: paymentSourceExtendedInclude,
	});
}

export type PaymentSourceExtendedListRecord = Awaited<ReturnType<typeof getPaymentSourceExtendedForQuery>>[number];
