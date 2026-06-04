import { prisma } from '@masumi/payment-core/db';
import { AuthContext } from '@masumi/payment-core/auth';
import { buildHotWalletScopeFilter } from '@/utils/shared/wallet-scope';
import { z } from '@masumi/payment-core/zod';
import { paymentSourceSchemaInput } from './schemas';

export type PaymentSourceListQueryInput = z.infer<typeof paymentSourceSchemaInput>;

export async function getPaymentSourcesForQuery(
	input: PaymentSourceListQueryInput,
	networkLimit: AuthContext['networkLimit'],
	walletScopeIds: AuthContext['walletScopeIds'],
) {
	return prisma.paymentSource.findMany({
		take: input.take,
		orderBy: {
			createdAt: 'desc',
		},
		cursor: input.cursorId ? { id: input.cursorId } : undefined,
		where: {
			network: { in: networkLimit },
			deletedAt: null,
		},
		include: {
			AdminWallets: {
				orderBy: { order: 'asc' },
				select: { walletAddress: true, order: true },
			},
			HotWallets: {
				where: { deletedAt: null, ...buildHotWalletScopeFilter(walletScopeIds) },
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
				select: {
					walletAddress: true,
				},
			},
		},
	});
}

export type PaymentSourceListRecord = Awaited<ReturnType<typeof getPaymentSourcesForQuery>>[number];
