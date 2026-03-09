import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { z } from '@/utils/zod-openapi';
import { recordBusinessEndpointError } from '@/utils/metrics';
import { AuthContext } from '@/utils/middleware/auth-middleware';
import { invoiceGenerationSchemaInput, invoiceGenerationSchemaOutput, generateMonthlyInvoice } from '../shared';

export const postInternalGenerateMonthlyInvoiceSchemaInput = invoiceGenerationSchemaInput;
export const postInternalGenerateMonthlyInvoiceSchemaOutput = invoiceGenerationSchemaOutput;

export const postInternalGenerateMonthlyInvoiceEndpoint = payAuthenticatedEndpointFactory.build({
	method: 'post',
	input: postInternalGenerateMonthlyInvoiceSchemaInput,
	output: postInternalGenerateMonthlyInvoiceSchemaOutput,
	handler: async ({
		input,
		ctx,
	}: {
		input: z.infer<typeof postInternalGenerateMonthlyInvoiceSchemaInput>;
		ctx: AuthContext;
	}) => {
		const startTime = Date.now();
		try {
			const result = await generateMonthlyInvoice(
				{
					buyerWalletVkey: input.buyerWalletVkey,
					sellerWalletVkey: input.sellerWalletVkey,
					month: input.month,
					invoiceCurrency: input.invoiceCurrency,
					currencyConversion: input.CurrencyConversion,
					invoice: input.Invoice,
					vatRate: input.vatRate,
					reverseCharge: input.reverseCharge,
					forceRegenerate: input.forceRegenerate,
					seller: input.Seller,
					buyer: input.Buyer,
				},
				{
					metricPath: '/api/v1/invoice/monthly/internal',
					walletScopeIds: ctx.walletScopeIds,
				},
			);

			return result;
		} catch (error) {
			const errorInstance = error instanceof Error ? error : new Error(String(error));
			const statusCode =
				(errorInstance as { statusCode?: number; status?: number }).statusCode ||
				(errorInstance as { statusCode?: number; status?: number }).status ||
				500;
			recordBusinessEndpointError('/api/v1/invoice/monthly/internal', 'POST', statusCode, errorInstance, {
				user_id: ctx.id,
				operation: 'internal_generate_invoice',
				duration: Date.now() - startTime,
			});
			throw error;
		}
	},
});
