import { z } from '@/utils/zod-openapi';
import { ez } from 'express-zod-api';
import { prisma } from '@/utils/db';
import { Network, Prisma } from '@/generated/prisma/client';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import createHttpError from 'http-errors';
import { queryRegistryInboxRequestSchemaOutput } from '@/routes/api/registry-inbox';
import { buildManagedHolderWalletScopeFilter } from '@/utils/shared/wallet-scope';
import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import { serializeInboxRegistryEntriesResponse } from '../serializers';

const registryDiffLastUpdateSchema = ez.dateIn();

export const queryRegistryInboxDiffSchemaInput = z.object({
	limit: z.coerce.number().min(1).max(100).default(10).describe('The number of inbox registry entries to return'),
	cursorId: z
		.string()
		.optional()
		.describe(
			'Pagination cursor (inbox registry request id). Used as tie-breaker when lastUpdate equals a state-change timestamp',
		),
	lastUpdate: registryDiffLastUpdateSchema
		.default(() => registryDiffLastUpdateSchema.parse(new Date(0).toISOString()))
		.describe('Return inbox registry entries whose registration state changed at/after this ISO timestamp'),
	network: z.nativeEnum(Network).describe('The Cardano network used to register the inbox agent on'),
	filterSmartContractAddress: z
		.string()
		.optional()
		.nullable()
		.describe('The smart contract address of the payment source'),
});

function buildRegistryInboxDiffWhere({
	lastUpdate,
	cursorId,
	network,
	filterSmartContractAddress,
	walletScopeIds,
}: {
	lastUpdate: Date;
	cursorId?: string;
	network: Prisma.PaymentSourceWhereInput['network'];
	filterSmartContractAddress?: string | null;
	walletScopeIds: string[] | null;
}): Prisma.InboxAgentRegistrationRequestWhereInput {
	const base: Prisma.InboxAgentRegistrationRequestWhereInput = {
		PaymentSource: {
			network,
			deletedAt: null,
			smartContractAddress: filterSmartContractAddress ?? undefined,
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

export const queryRegistryInboxDiffGet = readAuthenticatedEndpointFactory.build({
	method: 'get',
	input: queryRegistryInboxDiffSchemaInput,
	output: queryRegistryInboxRequestSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof queryRegistryInboxDiffSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

		const result = await prisma.inboxAgentRegistrationRequest.findMany({
			where: buildRegistryInboxDiffWhere({
				lastUpdate: input.lastUpdate,
				cursorId: input.cursorId,
				network: input.network,
				filterSmartContractAddress: input.filterSmartContractAddress,
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
			},
		});

		if (result == null) {
			throw createHttpError(404, 'Inbox registry entry not found');
		}

		return serializeInboxRegistryEntriesResponse(result);
	},
});
