import { z } from '@masumi/payment-core/zod';
import { recordBusinessEndpointError } from '@masumi/payment-core/metrics';
import { readAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { AuthContext } from '@masumi/payment-core/auth';
import createHttpError from 'http-errors';
import { assertDisclosureReadWalletInScope } from '@/services/dispute-disclosure/disclosure-read-wallet-scope';
import {
	loadDisputedPaymentContext,
	revealDataSignatureInputSchema,
	verifyRevealDataSignature,
} from '@/utils/signature/reveal-data-signature';

export const postVerifyDataRevealSchemaInput = revealDataSignatureInputSchema;

export const postRevealDataSchemaOutput = z.object({
	isValid: z.boolean().describe('Whether the signature is valid and the data can be revealed'),
});

export const revealDataEndpointPost = readAuthenticatedEndpointFactory.build({
	method: 'post',
	input: postVerifyDataRevealSchemaInput,
	output: postRevealDataSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof postVerifyDataRevealSchemaInput>; ctx: AuthContext }) => {
		const startTime = Date.now();
		try {
			const context = await loadDisputedPaymentContext(input.blockchainIdentifier);
			if (context == null) {
				recordBusinessEndpointError('/api/v1/reveal-data', 'POST', 404, 'Payment not found', {
					wallet_address: input.walletAddress,
					blockchain_identifier: input.blockchainIdentifier,
					valid_until: input.validUntil,
				});
				throw createHttpError(404, 'Payment not found');
			}

			assertDisclosureReadWalletInScope(ctx.walletScopeIds, {
				kind: context.requestKind,
				smartContractWalletId: context.smartContractWalletId,
				sellerHotWalletId: context.sellerHotWalletId,
			});
			if (!ctx.canAdmin && !ctx.networkLimit.includes(context.network)) {
				recordBusinessEndpointError('/api/v1/reveal-data', 'POST', 403, 'Payment is not on the requested network');
				throw createHttpError(403, 'Network not allowed');
			}

			const isValid = await verifyRevealDataSignature(input, context);
			return { isValid };
		} catch (error) {
			const errorInstance = error instanceof Error ? error : new Error(String(error));
			const statusCode =
				(errorInstance as { statusCode?: number; status?: number }).statusCode ||
				(errorInstance as { statusCode?: number; status?: number }).status ||
				500;
			recordBusinessEndpointError('/api/v1/reveal-data', 'POST', statusCode, errorInstance, {
				user_id: ctx.id,
				wallet_id: input.walletAddress,
				blockchain_identifier: input.blockchainIdentifier,
				valid_until: input.validUntil,
				duration: Date.now() - startTime,
			});
			throw error;
		}
	},
});
