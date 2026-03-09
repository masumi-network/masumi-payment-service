import { prisma } from '@/utils/db';
import { AuthContext } from '@/utils/middleware/auth-middleware';
import { z } from '@/utils/zod-openapi';
import { paymentSourceExtendedSchemaInput } from './schemas';

export type PaymentSourceExtendedListQueryInput = z.infer<typeof paymentSourceExtendedSchemaInput>;

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
		include: {
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
				},
			},
			FeeReceiverNetworkWallet: {
				select: { walletAddress: true },
			},
			PaymentSourceConfig: {
				select: { rpcProviderApiKey: true, rpcProvider: true },
			},
		},
	});
}

export type PaymentSourceExtendedListRecord = Awaited<ReturnType<typeof getPaymentSourceExtendedForQuery>>[number];
