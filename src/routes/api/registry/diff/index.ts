import { z } from '@masumi/payment-core/zod';
import { ez } from 'express-zod-api';
import { prisma } from '@masumi/payment-core/db';
import { Network, PaymentSourceType, Prisma } from '@/generated/prisma/client';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@masumi/payment-core/auth';
import createHttpError from 'http-errors';
import { queryRegistryRequestSchemaOutput } from '@/routes/api/registry';
import { buildManagedHolderWalletScopeFilter } from '@/utils/shared/wallet-scope';
import { readAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { serializeRegistryEntriesResponse } from '../serializers';

const registryDiffLastUpdateSchema = ez.dateIn();

export const queryRegistryDiffSchemaInput = z.object({
	limit: z.coerce.number().min(1).max(100).default(10).describe('The number of registry entries to return'),
	cursorId: z
		.string()
		.optional()
		.describe(
			'Pagination cursor (registry request id). Used as tie-breaker when lastUpdate equals a state-change timestamp',
		),
	lastUpdate: registryDiffLastUpdateSchema
		.default(() => registryDiffLastUpdateSchema.parse(new Date(0).toISOString()))
		.describe('Return registry entries whose registration state changed at/after this ISO timestamp'),
	network: z.nativeEnum(Network).describe('The Cardano network used to register the agent on'),
	filterSmartContractAddress: z
		.string()
		.optional()
		.nullable()
		.describe('The smart contract address of the payment source'),
	filterPaymentSourceType: z.nativeEnum(PaymentSourceType).optional().describe('Filter by payment source type'),
});

function buildRegistryDiffWhere({
	lastUpdate,
	cursorId,
	network,
	filterSmartContractAddress,
	filterPaymentSourceType,
	walletScopeIds,
}: {
	lastUpdate: Date;
	cursorId?: string;
	network: Prisma.PaymentSourceWhereInput['network'];
	filterSmartContractAddress?: string | null;
	filterPaymentSourceType?: PaymentSourceType;
	walletScopeIds: string[] | null;
}): Prisma.RegistryRequestWhereInput {
	const base: Prisma.RegistryRequestWhereInput = {
		PaymentSource: {
			network,
			deletedAt: null,
			smartContractAddress: filterSmartContractAddress ?? undefined,
			paymentSourceType: filterPaymentSourceType,
		},
		SmartContractWallet: { deletedAt: null },
		...buildManagedHolderWalletScopeFilter(walletScopeIds),
	};

	return cursorId != null
		? {
				...base,
				OR: [
					{ registrationStateLastChangedAt: { gt: lastUpdate } },
					{ registrationStateLastChangedAt: lastUpdate, id: { gte: cursorId } },
				],
			}
		: { ...base, registrationStateLastChangedAt: { gte: lastUpdate } };
}

export const queryRegistryDiffGet = readAuthenticatedEndpointFactory.build({
	method: 'get',
	input: queryRegistryDiffSchemaInput,
	output: queryRegistryRequestSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof queryRegistryDiffSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

		const result = await prisma.registryRequest.findMany({
			where: buildRegistryDiffWhere({
				lastUpdate: input.lastUpdate,
				cursorId: input.cursorId,
				network: input.network,
				filterSmartContractAddress: input.filterSmartContractAddress,
				filterPaymentSourceType: input.filterPaymentSourceType,
				walletScopeIds: ctx.walletScopeIds,
			}),
			orderBy: [{ registrationStateLastChangedAt: 'asc' }, { id: 'asc' }],
			take: input.limit,
			include: {
				SmartContractWallet: {
					select: { walletVkey: true, walletAddress: true },
				},
				RecipientWallet: {
					select: { walletVkey: true, walletAddress: true },
				},
				CurrentTransaction: {
					select: {
						txHash: true,
						status: true,
						confirmations: true,
						fees: true,
						blockHeight: true,
						blockTime: true,
					},
				},
				Pricing: {
					include: {
						FixedPricing: {
							include: { Amounts: { select: { unit: true, amount: true } } },
						},
					},
				},
				ExampleOutputs: {
					select: {
						name: true,
						url: true,
						mimeType: true,
					},
				},
				SupportedPaymentSources: {
					select: {
						chain: true,
						network: true,
						paymentSourceType: true,
						address: true,
						scheme: true,
						asset: true,
						amount: true,
						decimals: true,
						payTo: true,
						resource: true,
						extra: true,
					},
				},
			},
		});

		if (result == null) {
			throw createHttpError(404, 'Registry entry not found');
		}

		return serializeRegistryEntriesResponse(result);
	},
});
