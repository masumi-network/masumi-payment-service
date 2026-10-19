import { z } from '@masumi/payment-core/zod';
import { payAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@masumi/payment-core/auth';
import { Network } from '@/generated/prisma/client';
import createHttpError from 'http-errors';
import { assertWalletInScope } from '@/utils/shared/wallet-scope';
import { upsertDisputeInputData } from '@/services/dispute-disclosure/storage';
import { findDisputedV2Request } from '@/services/dispute-disclosure/lookup';

export const postDisputeInputDataSchemaInput = z.object({
	network: z.nativeEnum(Network),
	blockchainIdentifier: z.string().min(1).max(2500),
	inputData: z
		.string()
		.min(1)
		.max(2_000_000)
		.describe('Raw UTF-8 input string; must SHA-256 hash to inputHash on chain'),
});

export const postDisputeInputDataSchemaOutput = z.object({
	blockchainIdentifier: z.string(),
	stored: z.literal(true),
});

export const postDisputeInputDataEndpointPost = payAuthenticatedEndpointFactory.build({
	method: 'post',
	input: postDisputeInputDataSchemaInput,
	output: postDisputeInputDataSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof postDisputeInputDataSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

		const target = await findDisputedV2Request({
			blockchainIdentifier: input.blockchainIdentifier,
			network: input.network,
		});
		if (target == null) {
			throw createHttpError(404, 'Disputed V2 payment or purchase not found');
		}
		assertWalletInScope(ctx.walletScopeIds, target.smartContractWalletId);
		if (target.requestedById !== ctx.id && !ctx.canAdmin) {
			throw createHttpError(403, 'Not authorized to upload disclosure data for this request');
		}

		await upsertDisputeInputData({
			blockchainIdentifier: input.blockchainIdentifier,
			data: input.inputData,
			expectedInputHash: target.inputHash,
		});

		return { blockchainIdentifier: input.blockchainIdentifier, stored: true };
	},
});
