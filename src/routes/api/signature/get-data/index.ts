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
import { markRevealSignatureUsed } from '@/utils/signature/reveal-data-replay-cache';
import { readDisputeDisclosurePlaintext } from '@/services/dispute-disclosure/storage';

export const getDisputeDataSchemaInput = revealDataSignatureInputSchema;

export const getDisputeDataSchemaOutput = z.object({
	isValid: z.boolean().describe('Whether the admin signature is valid'),
	replayRejected: z
		.boolean()
		.optional()
		.describe('True when this signature was already used outside its validity window'),
	decryptFailed: z
		.boolean()
		.optional()
		.describe('True when stored ciphertext could not be decrypted (signature may still be valid)'),
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
				throw createHttpError(404, 'Disputed request not found');
			}

			assertDisclosureReadWalletInScope(ctx.walletScopeIds, {
				kind: context.requestKind,
				smartContractWalletId: context.smartContractWalletId,
				sellerHotWalletId: context.sellerHotWalletId,
			});
			if (!ctx.canAdmin && !ctx.networkLimit.includes(context.network)) {
				throw createHttpError(403, 'Network not allowed');
			}

			const isValid = await verifyRevealDataSignature(input, context);
			if (!isValid) {
				return {
					isValid: false,
					decryptFailed: false,
					inputHash: '',
					resultHash: null,
					inputData: null,
					resultData: null,
				};
			}

			const plaintext = await readDisputeDisclosurePlaintext(input.blockchainIdentifier);
			const hasPlaintext =
				(plaintext.inputData != null && plaintext.inputData.length > 0) ||
				(plaintext.resultData != null && plaintext.resultData.length > 0);

			if (plaintext.decryptFailed && !hasPlaintext) {
				return {
					isValid: true,
					decryptFailed: true,
					replayRejected: false,
					inputHash: context.inputHash,
					resultHash: context.resultHash,
					inputData: null,
					resultData: null,
				};
			}

			if (!hasPlaintext) {
				return {
					isValid: true,
					decryptFailed: false,
					replayRejected: false,
					inputHash: context.inputHash,
					resultHash: context.resultHash,
					inputData: null,
					resultData: null,
				};
			}

			const replayMark = await markRevealSignatureUsed({
				signature: input.signature,
				key: input.key,
				blockchainIdentifier: input.blockchainIdentifier,
				validUntil: input.validUntil,
			});
			if (replayMark.status === 'rejected') {
				return {
					isValid: false,
					replayRejected: true,
					decryptFailed: false,
					inputHash: '',
					resultHash: null,
					inputData: null,
					resultData: null,
				};
			}

			return {
				isValid: true,
				decryptFailed: plaintext.decryptFailed,
				replayRejected: false,
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
				admin_signer_address: input.walletAddress,
				blockchain_identifier: input.blockchainIdentifier,
				valid_until: input.validUntil,
				duration: Date.now() - startTime,
			});
			throw error;
		}
	},
});
