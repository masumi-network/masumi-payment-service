import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { z } from '@/utils/zod-openapi';
import { prisma } from '@/utils/db';

export const getMonthlyInvoiceListSchemaInput = z.object({
	month: z
		.string()
		.regex(/^\d{4}-\d{2}$/)
		.describe('Target month in format YYYY-MM (UTC calendar)'),
	cursorId: z.string().optional().describe('Cursor for pagination (InvoiceBase id)'),
	limit: z.coerce.number().min(1).max(100).default(10).describe('Number of results to return'),
	includeAllRevisions: z.coerce
		.boolean()
		.optional()
		.default(false)
		.describe('When true, return all revisions including cancelled; when false, return only latest revision per base'),
});

const invoiceSummarySchema = z.object({
	id: z.string(),
	invoiceId: z.string(),
	createdAt: z.date(),
	revisionId: z.string(),
	revisionNumber: z.number(),
	invoiceMonth: z.number(),
	invoiceYear: z.number(),
	invoiceDate: z.date(),
	currencyShortId: z.string(),
	sellerName: z.string().nullable(),
	sellerCompanyName: z.string().nullable(),
	buyerName: z.string().nullable(),
	buyerCompanyName: z.string().nullable(),
	isCancelled: z.boolean(),
	cancellationReason: z.string().nullable(),
	cancellationDate: z.date().nullable(),
	cancellationId: z.string().nullable(),
	itemCount: z.number(),
	netTotal: z.string(),
	vatTotal: z.string(),
	grossTotal: z.string(),
	coveredPaymentRequestIds: z.array(z.string()),
});

export const getMonthlyInvoiceListSchemaOutput = z.object({
	Invoices: z.array(invoiceSummarySchema),
});

export const getMonthlyInvoiceListEndpoint = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: getMonthlyInvoiceListSchemaInput,
	output: getMonthlyInvoiceListSchemaOutput,
	handler: async ({ input }: { input: z.infer<typeof getMonthlyInvoiceListSchemaInput> }) => {
		const [yearStr, monthStr] = input.month.split('-');
		const year = Number(yearStr);
		const monthNum = Number(monthStr);

		const invoiceBases = await prisma.invoiceBase.findMany({
			where: {
				InvoiceRevisions: {
					some: {
						invoiceMonth: monthNum,
						invoiceYear: year,
					},
				},
				...(input.cursorId ? { id: { lt: input.cursorId } } : {}),
			},
			include: {
				InvoiceRevisions: {
					where: {
						invoiceMonth: monthNum,
						invoiceYear: year,
					},
					orderBy: { revisionNumber: 'desc' },
					...(input.includeAllRevisions ? {} : { take: 1 }),
					include: {
						InvoiceItems: true,
					},
				},
				coveredPaymentRequests: {
					select: { id: true },
				},
			},
			orderBy: { createdAt: 'desc' },
			take: input.limit,
		});

		const invoices = invoiceBases.flatMap((base) =>
			base.InvoiceRevisions.map((rev) => {
				let netTotal = 0;
				let vatTotal = 0;
				let grossTotal = 0;
				for (const item of rev.InvoiceItems) {
					const qty = Number(item.quantity);
					const unitPrice = Number(item.pricePerUnitWithoutVat);
					const net = qty * unitPrice;
					const vat = Number(item.vatAmount);
					const total = Number(item.totalAmount);
					netTotal += net;
					vatTotal += vat;
					grossTotal += total;
				}

				return {
					id: base.id,
					invoiceId: base.invoiceId,
					createdAt: base.createdAt,
					revisionId: rev.id,
					revisionNumber: rev.revisionNumber,
					invoiceMonth: rev.invoiceMonth,
					invoiceYear: rev.invoiceYear,
					invoiceDate: rev.invoiceDate,
					currencyShortId: rev.currencyShortId,
					sellerName: rev.sellerName,
					sellerCompanyName: rev.sellerCompanyName,
					buyerName: rev.buyerName,
					buyerCompanyName: rev.buyerCompanyName,
					isCancelled: rev.isCancelled,
					cancellationReason: rev.cancellationReason,
					cancellationDate: rev.cancellationDate,
					cancellationId: rev.cancellationId,
					itemCount: rev.InvoiceItems.length,
					netTotal: netTotal.toFixed(2),
					vatTotal: vatTotal.toFixed(2),
					grossTotal: grossTotal.toFixed(2),
					coveredPaymentRequestIds: base.coveredPaymentRequests.map((p) => p.id),
				};
			}),
		);

		return { Invoices: invoices };
	},
});
