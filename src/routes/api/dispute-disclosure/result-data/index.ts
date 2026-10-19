import { z } from '@masumi/payment-core/zod';
import { payAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@masumi/payment-core/auth';
import { Network } from '@/generated/prisma/client';
import createHttpError from 'http-errors';
import { assertWalletInScope } from '@/utils/shared/wallet-scope';
import { upsertDisputeResultData } from '@/services/dispute-disclosure/storage';
import { findDisputedV2Request } from '@/services/dispute-disclosure/lookup';

export const postDisputeResultDataSchemaInput = z.object({
	network: z.nativeEnum(Network),
	blockchainIdentifier: z.string().min(1).max(2500),
	resultData: z
		.string()
		.min(1)
		.max(2_000_000)
		.describe('Raw UTF-8 result string; must SHA-256 hash to resultHash on chain'),
});

export const postDisputeResultDataSchemaOutput = z.object({
	blockchainIdentifier: z.string(),
	stored: z.literal(true),
});

export const postDisputeResultDataEndpointPost = payAuthenticatedEndpointFactory.build({
	method: 'post',
	input: postDisputeResultDataSchemaInput,
	output: postDisputeResultDataSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof postDisputeResultDataSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

		const target = await findDisputedV2Request({
			blockchainIdentifier: input.blockchainIdentifier,
			network: input.network,
		});
		if (target == null) {
			throw createHttpError(404, 'Disputed V2 payment or purchase not found');
		}
		if (target.resultHash == null) {
			throw createHttpError(400, 'Request has no on-chain result hash yet');
		}
		assertWalletInScope(ctx.walletScopeIds, target.smartContractWalletId);
		if (target.requestedById !== ctx.id && !ctx.canAdmin) {
			throw createHttpError(403, 'Not authorized to upload disclosure data for this request');
		}

		await upsertDisputeResultData({
			blockchainIdentifier: input.blockchainIdentifier,
			data: input.resultData,
			expectedResultHash: target.resultHash,
		});

		return { blockchainIdentifier: input.blockchainIdentifier, stored: true };
	},
});
