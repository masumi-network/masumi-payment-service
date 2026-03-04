import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { z } from '@/utils/zod-openapi';
import { recordBusinessEndpointError } from '@/utils/metrics';
import { AuthContext } from '@/utils/middleware/auth-middleware';
import { invoiceGenerationSchemaInput, invoiceGenerationSchemaOutput, generateMonthlyInvoice } from '../shared';

export const postAdminGenerateMonthlyInvoiceSchemaInput = invoiceGenerationSchemaInput;
export const postAdminGenerateMonthlyInvoiceSchemaOutput = invoiceGenerationSchemaOutput;

export const postAdminGenerateMonthlyInvoiceEndpoint = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: postAdminGenerateMonthlyInvoiceSchemaInput,
	output: postAdminGenerateMonthlyInvoiceSchemaOutput,
	handler: async ({
		input,
		ctx,
	}: {
		input: z.infer<typeof postAdminGenerateMonthlyInvoiceSchemaInput>;
		ctx: AuthContext;
	}) => {
		const startTime = Date.now();
		try {
			const result = await generateMonthlyInvoice(input, {
				metricPath: '/api/v1/invoice/monthly/admin',
			});

			return result;
		} catch (error) {
			const errorInstance = error instanceof Error ? error : new Error(String(error));
			const statusCode =
				(errorInstance as { statusCode?: number; status?: number }).statusCode ||
				(errorInstance as { statusCode?: number; status?: number }).status ||
				500;
			recordBusinessEndpointError('/api/v1/invoice/monthly/admin', 'POST', statusCode, errorInstance, {
				user_id: ctx.id,
				operation: 'admin_generate_invoice',
				duration: Date.now() - startTime,
			});
			throw error;
		}
	},
});
