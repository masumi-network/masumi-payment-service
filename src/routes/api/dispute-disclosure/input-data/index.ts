import { z } from '@masumi/payment-core/zod';
import { payAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { AuthContext } from '@masumi/payment-core/auth';
import { Network } from '@/generated/prisma/client';
import createHttpError from 'http-errors';
import { assertDisclosureInputWalletInScope } from '@/services/dispute-disclosure/disclosure-wallet-scope';
import { upsertDisputeInputData } from '@/services/dispute-disclosure/storage';
import { findDisputedV2Request } from '@/services/dispute-disclosure/lookup';
import { assertCanUploadDisclosureInput } from '@/services/dispute-disclosure/upload-authorization';

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

		const target = await findDisputedV2Request({
			blockchainIdentifier: input.blockchainIdentifier,
			network: input.network,
		});
		if (target == null) {
			throw createHttpError(404, 'Disputed V2 payment or purchase not found');
		}
		assertCanUploadDisclosureInput(ctx, target);
		assertDisclosureInputWalletInScope(ctx.walletScopeIds, target, ctx.id);

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
