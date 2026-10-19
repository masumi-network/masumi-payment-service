import { z } from '@masumi/payment-core/zod';
import { payAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { AuthContext } from '@masumi/payment-core/auth';
import { Network } from '@/generated/prisma/client';
import createHttpError from 'http-errors';
import { assertDisclosureResultWalletInScope } from '@/services/dispute-disclosure/disclosure-wallet-scope';
import { upsertDisputeResultData } from '@/services/dispute-disclosure/storage';
import { findDisputedV2Request } from '@/services/dispute-disclosure/lookup';
import { assertCanUploadDisclosureResult } from '@/services/dispute-disclosure/upload-authorization';

export const postDisputeResultDataSchemaInput = z.object({
	network: z.nativeEnum(Network),
	blockchainIdentifier: z.string().min(1).max(2500),
	resultData: z
		.string()
		.min(1)
		.refine((value) => Buffer.byteLength(value, 'utf8') <= 2_000_000, {
			message: 'resultData exceeds maximum allowed size',
		})
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
		if (target.resultHash == null) {
			throw createHttpError(400, 'Request has no on-chain result hash yet');
		}
		assertCanUploadDisclosureResult(ctx, target);
		assertDisclosureResultWalletInScope(ctx.walletScopeIds, target);

		await upsertDisputeResultData({
			blockchainIdentifier: input.blockchainIdentifier,
			data: input.resultData,
			expectedResultHash: target.resultHash,
			uploaderId: ctx.id,
		});

		return {
			blockchainIdentifier: input.blockchainIdentifier,
			stored: true as const,
		};
	},
});
