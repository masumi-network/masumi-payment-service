import { z } from 'zod';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { HotWalletType } from '@prisma/client';
import { recordBusinessEndpointError } from '@/utils/metrics';
import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { AuthContext } from '@/utils/middleware/auth-middleware';
import { assertHotWalletInScope } from '@/utils/shared/wallet-scope';
import { generateWalletExtended } from '@/utils/generator/wallet-generator';
import stringify from 'canonical-json';
import { generateHash } from '@/utils/crypto';

export const postMonthlySignatureSchemaInput = z
	.object({
		buyerWalletVkey: z.string().min(1).max(1000).describe('The buyer wallet vkey for which to aggregate the month'),
		month: z
			.string()
			.regex(/^\d{4}-\d{2}$/)
			.describe('Target month in format YYYY-MM (UTC calendar)'),
		action: z.enum(['retrieveMonthlyInvoices']).describe('The action to perform for monthly invoices'),
		buyer: z.object({
			country: z.string().min(1).max(100).describe('The country of the invoice'),
			city: z.string().min(1).max(100).describe('The city of the invoice'),
			zipCode: z.string().min(1).max(20).describe('The zip code of the invoice'),
			street: z.string().min(1).max(100).describe('The street of the invoice'),
			streetNumber: z.string().min(1).max(20).describe('The street number of the invoice'),
			email: z.string().email().min(1).max(100).nullable().describe('The email of the invoice'),
			phone: z.string().min(1).max(100).nullable().describe('The phone of the invoice'),
			name: z.string().min(1).max(100).nullable().describe('The name of the invoice'),
			companyName: z.string().min(1).max(100).nullable().describe('The company name of the invoice'),
			vatNumber: z.string().min(1).max(100).nullable().describe('The VAT number of the invoice'),
		}),
	})
	.refine((data) => {
		if (data.buyer.companyName == null && data.buyer.name == null) {
			return false;
		}
		return true;
	});

export const postMonthlySignatureSchemaOutput = z.object({
	signature: z.string(),
	key: z.string(),
	walletAddress: z.string(),
	signatureData: z.string(),
});

export const postMonthlySignatureEndpoint = payAuthenticatedEndpointFactory.build({
	method: 'post',
	input: postMonthlySignatureSchemaInput,
	output: postMonthlySignatureSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof postMonthlySignatureSchemaInput>; ctx: AuthContext }) => {
		const startTime = Date.now();
		try {
			const [yearStr, monthStr] = input.month.split('-');
			const year = Number(yearStr);
			const monthIdx = Number(monthStr) - 1; // 0-based
			if (!Number.isFinite(year) || !Number.isFinite(monthIdx) || monthIdx < 0 || monthIdx > 11) {
				throw createHttpError(400, 'Invalid month parameter');
			}

			const wallet = await prisma.hotWallet.findFirst({
				where: {
					walletVkey: input.buyerWalletVkey,
					type: HotWalletType.Purchasing,
				},
				include: {
					Secret: true,
					PaymentSource: { include: { PaymentSourceConfig: true } },
				},
			});

			if (wallet == null) {
				throw createHttpError(404, 'No wallet found');
			}
			assertHotWalletInScope(ctx.walletScopeIds, wallet.id);

			const { wallet: meshWallet } = await generateWalletExtended(
				wallet.PaymentSource.network,
				wallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
				wallet.Secret.encryptedMnemonic,
			);

			const signedData = stringify({
				buyer: input.buyer,
				buyerWalletVkey: input.buyerWalletVkey,
				month: input.month,
			});

			const hash = generateHash(signedData);

			const message = stringify({
				action: input.action,
				validUntil: Date.now() + 1000 * 60 * 60,
				hash: hash,
			});

			const signature = await meshWallet.signData(message, wallet.walletAddress);

			return {
				signature: signature.signature,
				key: signature.key,
				walletAddress: wallet.walletAddress,
				signatureData: message,
			};
		} catch (error) {
			const errorInstance = error instanceof Error ? error : new Error(String(error));
			const statusCode =
				(errorInstance as { statusCode?: number; status?: number }).statusCode ||
				(errorInstance as { statusCode?: number; status?: number }).status ||
				500;
			recordBusinessEndpointError('/api/v1/signature/monthly', 'POST', statusCode, errorInstance, {
				user_id: ctx.id,
				buyer_wallet_vkey: input.buyerWalletVkey,
				operation: 'get_signature_monthly',
				duration: Date.now() - startTime,
			});
			throw error;
		}
	},
});
