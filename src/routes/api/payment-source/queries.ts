import { prisma } from '@masumi/payment-core/db';
import { AuthContext } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { paymentSourceSchemaInput } from './schemas';

export type PaymentSourceListQueryInput = z.infer<typeof paymentSourceSchemaInput>;

export async function getPaymentSourcesForQuery(
	input: PaymentSourceListQueryInput,
	networkLimit: AuthContext['networkLimit'],
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
			FeeReceiverNetworkWallet: {
				select: {
					walletAddress: true,
				},
			},
		},
	});
}

export type PaymentSourceListRecord = Awaited<ReturnType<typeof getPaymentSourcesForQuery>>[number];
