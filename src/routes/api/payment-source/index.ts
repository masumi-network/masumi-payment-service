import { prisma } from '@/utils/db';
import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import { z } from '@/utils/zod-openapi';
import { splitWalletsByType } from '@/utils/shared/transformers';
import { AuthContext } from '@/utils/middleware/auth-middleware';
import { buildHotWalletScopeFilter } from '@/utils/shared/wallet-scope';
import {
	adminWalletSchema,
	paymentSourceOutputSchema,
	paymentSourceSchemaInput,
	paymentSourceSchemaOutput,
	purchasingWalletSchema,
	sellingWalletSchema,
} from './schemas';

export {
	adminWalletSchema,
	paymentSourceOutputSchema,
	paymentSourceSchemaInput,
	paymentSourceSchemaOutput,
	purchasingWalletSchema,
	sellingWalletSchema,
};

export const paymentSourceEndpointGet = readAuthenticatedEndpointFactory.build({
	method: 'get',
	input: paymentSourceSchemaInput,
	output: paymentSourceSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof paymentSourceSchemaInput>; ctx: AuthContext }) => {
		const paymentSources = await prisma.paymentSource.findMany({
			take: input.take,
			orderBy: {
				createdAt: 'desc',
			},
			cursor: input.cursorId ? { id: input.cursorId } : undefined,
			where: {
				network: { in: ctx.networkLimit },
				deletedAt: null,
			},
			include: {
				AdminWallets: {
					orderBy: { order: 'asc' },
					select: { walletAddress: true, order: true },
				},
				HotWallets: {
					where: { deletedAt: null, ...buildHotWalletScopeFilter(ctx.walletScopeIds) },
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
					select: {
						walletAddress: true,
					},
				},
			},
		});
		const mappedPaymentSources = paymentSources.map((paymentSource) => {
			const { HotWallets, ...rest } = paymentSource;
			return {
				...rest,
				...splitWalletsByType(HotWallets),
			};
		});
		return { PaymentSources: mappedPaymentSources };
	},
});
