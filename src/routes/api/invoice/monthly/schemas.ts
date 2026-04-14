import { z } from '@/utils/zod-openapi';
import { invoiceGenerationBaseSchema, invoiceGenerationSchemaOutput } from './shared';

export const getMonthlyInvoiceListSchemaInput = z.object({
	month: z
		.string()
		.regex(/^\d{4}-\d{2}$/)
		.describe('Target month in format YYYY-MM (UTC calendar)'),
	cursorId: z.string().optional().describe('Cursor for pagination (InvoiceBase id)'),
	limit: z.coerce.number().min(1).max(100).default(10).describe('Number of results to return'),
	invoiceBaseId: z
		.string()
		.optional()
		.describe('When provided, return all revisions for this specific invoice base (ignores pagination)'),
});

export const invoiceSummarySchema = z.object({
	id: z.string(),
	invoiceId: z.string(),
	createdAt: z.date(),
	revisionId: z.string(),
	revisionNumber: z.number(),
	revisionCount: z.number().describe('Total number of revisions for this invoice base'),
	invoiceMonth: z.number(),
	invoiceYear: z.number(),
	invoiceDate: z.date(),
	currencyShortId: z.string(),
	reverseCharge: z.boolean(),
	language: z.string().nullable(),
	localizationFormat: z.string(),
	vatRate: z.number().nullable().describe('VAT rate from the first item, null if no items'),
	sellerName: z.string().nullable(),
	sellerCompanyName: z.string().nullable(),
	sellerVatNumber: z.string().nullable(),
	sellerCountry: z.string(),
	sellerCity: z.string(),
	sellerZipCode: z.string(),
	sellerStreet: z.string(),
	sellerStreetNumber: z.string(),
	sellerEmail: z.string().nullable(),
	sellerPhone: z.string().nullable(),
	buyerName: z.string().nullable(),
	buyerCompanyName: z.string().nullable(),
	buyerVatNumber: z.string().nullable(),
	buyerCountry: z.string(),
	buyerCity: z.string(),
	buyerZipCode: z.string(),
	buyerStreet: z.string(),
	buyerStreetNumber: z.string(),
	buyerEmail: z.string().nullable(),
	buyerPhone: z.string().nullable(),
	invoiceTitle: z.string().nullable(),
	invoiceDescription: z.string().nullable(),
	isCancelled: z.boolean(),
	cancellationReason: z.string().nullable(),
	cancellationDate: z.date().nullable(),
	cancellationId: z.string().nullable(),
	itemCount: z.number(),
	netTotal: z.string(),
	vatTotal: z.string(),
	grossTotal: z.string(),
	CoveredPaymentRequestIds: z.array(z.string()),
	buyerWalletVkey: z.string().nullable(),
	sellerWalletVkey: z.string().nullable(),
	invoicePdf: z.string().describe('Base64-encoded invoice PDF'),
	cancellationInvoicePdf: z.string().nullable().describe('Base64-encoded cancellation PDF if cancelled'),
});

export const getMonthlyInvoiceListSchemaOutput = z.object({
	Invoices: z.array(invoiceSummarySchema),
});

export const postGenerateMonthlyInvoiceSchemaInput = invoiceGenerationBaseSchema
	.extend({
		signature: z.string().max(2000).describe('The signature to verify'),
		key: z.string().max(2000).describe('The key to verify the signature'),
		walletAddress: z.string().max(500).describe('The wallet address that signed the message'),
		validUntil: z.number().describe('The valid until timestamp'),
		action: z.enum(['RetrieveMonthlyInvoices']).describe('The action to perform for monthly invoices'),
	})
	.refine(
		(data) => {
			const sellerCompanyName = data.Seller.companyName?.trim() ?? '';
			const sellerName = data.Seller.name?.trim() ?? '';
			if (sellerCompanyName.length === 0 && sellerName.length === 0) {
				return false;
			}
			return true;
		},
		{
			message: 'Seller company name or seller name is required',
			path: ['Seller', 'companyName'],
		},
	)
	.refine(
		(data) => {
			const buyerCompanyName = data.Buyer.companyName?.trim() ?? '';
			const buyerName = data.Buyer.name?.trim() ?? '';
			if (buyerCompanyName.length === 0 && buyerName.length === 0) {
				return false;
			}
			return true;
		},
		{
			message: 'Buyer company name or buyer name is required',
			path: ['Buyer', 'companyName'],
		},
	);

export const postGenerateMonthlyInvoiceSchemaOutput = invoiceGenerationSchemaOutput;
