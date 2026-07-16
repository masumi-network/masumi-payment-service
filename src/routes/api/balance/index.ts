import { Network } from '@/generated/prisma/client';
import { fetchAddressBalance } from '@/services/shared/address-balance';
import { prisma } from '@masumi/payment-core/db';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@masumi/payment-core/auth';
import { readAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import createHttpError from 'http-errors';

export const getBalanceSchemaInput = z.object({
	address: z.string().max(150).describe('The address to get the confirmed balance for'),
	network: z.nativeEnum(Network).describe('The Cardano network'),
});

export const balanceAmountSchema = z
	.object({
		unit: z
			.string()
			.describe(
				'Asset policy id + asset name concatenated. Use an empty string for ADA/lovelace e.g (1000000 lovelace = 1 ADA)',
			),
		quantity: z.coerce
			.number()
			.int()
			.min(0)
			.max(100000000000000)
			.describe('The quantity of the asset in its smallest unit. For ADA, this is lovelace (1 ADA = 1000000 lovelace)'),
	})
	.openapi('BalanceAmount');

export const getBalanceSchemaOutput = z.object({
	Balance: z.array(balanceAmountSchema).describe('Complete confirmed address balance aggregated across all UTXOs'),
});

export const queryBalanceEndpointGet = readAuthenticatedEndpointFactory.build({
	method: 'get',
	input: getBalanceSchemaInput,
	output: getBalanceSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof getBalanceSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);
		const paymentSource = await prisma.paymentSource.findFirst({
			where: { network: input.network, deletedAt: null },
			include: { PaymentSourceConfig: { select: { rpcProviderApiKey: true } } },
		});
		if (paymentSource == null) {
			throw createHttpError(404, 'Network not found');
		}

		try {
			const balance = await fetchAddressBalance({
				network: input.network,
				rpcProviderApiKey: paymentSource.PaymentSourceConfig.rpcProviderApiKey,
				address: input.address,
			});

			return {
				Balance: balance.map((amount) => ({
					unit: amount.unit,
					// Keep the established Cardano API convention: raw quantities are
					// numbers on the wire, even though internal monitoring uses bigint.
					quantity: parseInt(amount.quantity),
				})),
			};
		} catch {
			throw createHttpError(500, 'Failed to get address balance');
		}
	},
});
