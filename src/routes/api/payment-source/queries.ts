import { prisma } from '@masumi/payment-core/db';
import { cursorPaginationArgs } from '@/utils/shared/queries';
import { AuthContext } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { paymentSourceSchemaInput } from './schemas';

export type PaymentSourceListQueryInput = z.infer<typeof paymentSourceSchemaInput>;

export async function getPaymentSourcesForQuery(
	input: PaymentSourceListQueryInput,
	networkLimit: AuthContext['networkLimit'],
) {
	return prisma.paymentSource.findMany({
		orderBy: {
			createdAt: 'desc',
		},
		...cursorPaginationArgs(input.cursorId, input.take),
		where: {
			network: { in: networkLimit },
			deletedAt: null,
		},
		include: {
			AdminWallets: {
				orderBy: { order: 'asc' },
				select: { walletAddress: true, order: true },
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
