import { z } from '@masumi/payment-core/zod';
import { recordBusinessEndpointError } from '@masumi/payment-core/metrics';
import { readAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { AuthContext } from '@masumi/payment-core/auth';
import createHttpError from 'http-errors';
import { assertWalletInScope } from '@/utils/shared/wallet-scope';
import {
	loadDisputedPaymentContext,
	revealDataSignatureInputSchema,
	verifyRevealDataSignature,
} from '@/utils/signature/reveal-data-signature';
import { markRevealSignatureUsed } from '@/utils/signature/reveal-data-replay-cache';
import { readDisputeDisclosurePlaintext } from '@/services/dispute-disclosure/storage';

export const getDisputeDataSchemaInput = revealDataSignatureInputSchema;

export const getDisputeDataSchemaOutput = z.object({
	isValid: z.boolean().describe('Whether the admin signature is valid'),
	inputHash: z.string().describe('Expected SHA-256 hex hash of the input payload'),
	resultHash: z.string().nullable().describe('Expected SHA-256 hex hash of the result payload, if any'),
	inputData: z.string().nullable().describe('Decrypted input payload when stored and signature is valid'),
	resultData: z.string().nullable().describe('Decrypted result payload when stored and signature is valid'),
});

export const getDisputeDataEndpointPost = readAuthenticatedEndpointFactory.build({
	method: 'post',
	input: getDisputeDataSchemaInput,
	output: getDisputeDataSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof getDisputeDataSchemaInput>; ctx: AuthContext }) => {
		const startTime = Date.now();
		try {
			const context = await loadDisputedPaymentContext(input.blockchainIdentifier);
			if (context == null) {
				recordBusinessEndpointError('/api/v1/get-data', 'POST', 404, 'Payment not found', {
					blockchain_identifier: input.blockchainIdentifier,
				});
				throw createHttpError(404, 'Payment not found');
			}

			assertWalletInScope(ctx.walletScopeIds, context.smartContractWalletId);
			if (!ctx.canAdmin && !ctx.networkLimit.includes(context.network)) {
				throw createHttpError(403, 'Network not allowed');
			}

			const isValid = await verifyRevealDataSignature(input, context);
			if (!isValid) {
				return {
					isValid: false,
					inputHash: '',
					resultHash: null,
					inputData: null,
					resultData: null,
				};
			}

			if (
				!markRevealSignatureUsed({
					signature: input.signature,
					key: input.key,
					blockchainIdentifier: input.blockchainIdentifier,
					validUntil: input.validUntil,
				})
			) {
				return {
					isValid: false,
					inputHash: '',
					resultHash: null,
					inputData: null,
					resultData: null,
				};
			}

			const plaintext = await readDisputeDisclosurePlaintext(input.blockchainIdentifier);
			return {
				isValid: true,
				inputHash: context.inputHash,
				resultHash: context.resultHash,
				inputData: plaintext.inputData,
				resultData: plaintext.resultData,
			};
		} catch (error) {
			const errorInstance = error instanceof Error ? error : new Error(String(error));
			const statusCode =
				(errorInstance as { statusCode?: number; status?: number }).statusCode ||
				(errorInstance as { statusCode?: number; status?: number }).status ||
				500;
			recordBusinessEndpointError('/api/v1/get-data', 'POST', statusCode, errorInstance, {
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
