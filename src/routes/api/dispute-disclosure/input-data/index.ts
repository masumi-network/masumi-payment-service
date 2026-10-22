import { z } from '@masumi/payment-core/zod';
import { payAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { AuthContext } from '@masumi/payment-core/auth';
import { Network } from '@/generated/prisma/client';
import createHttpError from 'http-errors';
import { assertDisclosureInputWalletInScope } from '@/services/dispute-disclosure/disclosure-wallet-scope';
import { upsertDisputeInputData } from '@/services/dispute-disclosure/storage';
import { findDisputedV2RequestForUpload } from '@/services/dispute-disclosure/lookup';

export const postDisputeInputDataSchemaInput = z.object({
	network: z.nativeEnum(Network),
	blockchainIdentifier: z.string().min(1).max(2500),
	inputData: z
		.string()
		.min(1)
		.refine((value) => Buffer.byteLength(value, 'utf8') <= 2_000_000, {
			message: 'inputData exceeds maximum allowed size',
		})
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
		if (!ctx.canAdmin && !ctx.networkLimit.includes(input.network)) {
			throw createHttpError(403, 'Network not allowed');
		}

		const target = await findDisputedV2RequestForUpload(
			{
				blockchainIdentifier: input.blockchainIdentifier,
				network: input.network,
			},
			ctx,
			'input',
		);
		assertDisclosureInputWalletInScope(ctx.walletScopeIds, target, {
			requesterId: ctx.id,
			canAdmin: ctx.canAdmin,
		});

		await upsertDisputeInputData({
			blockchainIdentifier: input.blockchainIdentifier,
			data: input.inputData,
			expectedInputHash: target.inputHash,
			uploaderId: ctx.id,
		});

		return {
			blockchainIdentifier: input.blockchainIdentifier,
			stored: true as const,
		};
	},
});
