import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { z } from '@/utils/zod-openapi';
import createHttpError from 'http-errors';

import stringify from 'canonical-json';
import { recordBusinessEndpointError } from '@/utils/metrics';
import { checkSignature } from '@meshsdk/core';
import { generateHash } from '@/utils/crypto';
import { AuthContext } from '@/utils/middleware/auth-middleware';
import { invoiceGenerationBaseSchema, invoiceGenerationSchemaOutput, generateMonthlyInvoice } from './shared';

export const postGenerateMonthlyInvoiceSchemaInput = invoiceGenerationBaseSchema
	.extend({
		signature: z.string().max(2000).describe('The signature to verify'),
		key: z.string().max(2000).describe('The key to verify the signature'),
		walletAddress: z.string().max(500).describe('The wallet address that signed the message'),
		validUntil: z.number().describe('The valid until timestamp'),
		action: z.enum(['retrieve_monthly_invoices']).describe('The action to perform for monthly invoices'),
	})
	.refine(
		(data) => {
			if (data.seller.companyName == null && data.seller.name == null) {
				return false;
			}
			return true;
		},
		{
			message: 'Company name or name is required',
			path: ['seller', 'companyName'],
		},
	)
	.refine((data) => {
		if (data.buyer.companyName == null && data.buyer.name == null) {
			return false;
		}
		return true;
	});
export const postGenerateMonthlyInvoiceSchemaOutput = invoiceGenerationSchemaOutput;

export const postGenerateMonthlyInvoiceEndpoint = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: postGenerateMonthlyInvoiceSchemaInput,
	output: postGenerateMonthlyInvoiceSchemaOutput,
	handler: async ({
		input,
		ctx,
	}: {
		input: z.infer<typeof postGenerateMonthlyInvoiceSchemaInput>;
		ctx: AuthContext;
	}) => {
		const startTime = Date.now();
		try {
			if (Date.now() > input.validUntil) {
				throw createHttpError(400, 'Signature is expired');
			}
			if (Date.now() + 1000 * 60 * 60 * 2 < input.validUntil) {
				throw createHttpError(400, 'Signature is to far in the future');
			}

			const message = stringify({
				buyer: input.buyer,
				buyerWalletVkey: input.buyerWalletVkey,
				month: input.month,
			});
			const hash = generateHash(message);
			const signedData = stringify({
				action: input.action,
				validUntil: input.validUntil,
				hash: hash,
			});

			const isValid = await checkSignature(
				signedData,
				{
					signature: input.signature,
					key: input.key,
				},
				input.walletAddress,
			);
			if (!isValid) {
				throw createHttpError(400, 'Signature is not valid');
			}

			const result = await generateMonthlyInvoice(input, {
				walletAddress: input.walletAddress,
				metricPath: '/api/v1/invoice/monthly',
			});

			return result;
		} catch (error) {
			const errorInstance = error instanceof Error ? error : new Error(String(error));
			const statusCode =
				(errorInstance as { statusCode?: number; status?: number }).statusCode ||
				(errorInstance as { statusCode?: number; status?: number }).status ||
				500;
			recordBusinessEndpointError('/api/v1/invoice/monthly', 'POST', statusCode, errorInstance, {
				user_id: ctx.id,
				wallet_address: input.walletAddress,
				operation: 'verify_signature',
				duration: Date.now() - startTime,
			});
			throw error;
		}
	},
});
