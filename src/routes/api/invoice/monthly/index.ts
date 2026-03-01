import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { z } from '@/utils/zod-openapi';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';

import stringify from 'canonical-json';
import { recordBusinessEndpointError } from '@/utils/metrics';
import { checkSignature } from '@meshsdk/core';
import { generateHash } from '@/utils/crypto';
import { AuthContext } from '@/utils/middleware/auth-middleware';
import { invoiceGenerationBaseSchema, invoiceGenerationSchemaOutput, generateMonthlyInvoice } from './shared';

// ── GET /api/v1/invoice/monthly — List invoices ──

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

const invoiceSummarySchema = z.object({
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
	buyerWalletVkey: z.string().nullable(),
	invoicePdf: z.string().describe('Base64-encoded invoice PDF'),
	cancellationInvoicePdf: z.string().nullable().describe('Base64-encoded cancellation PDF if cancelled'),
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

		const isDetailQuery = !!input.invoiceBaseId;

		const invoiceBases = await prisma.invoiceBase.findMany({
			where: {
				...(isDetailQuery
					? { id: input.invoiceBaseId }
					: {
							invoiceMonth: monthNum,
							invoiceYear: year,
							...(input.cursorId ? { id: { lt: input.cursorId } } : {}),
						}),
			},
			include: {
				_count: {
					select: { InvoiceRevisions: true },
				},
				InvoiceRevisions: {
					orderBy: { revisionNumber: 'desc' },
					...(isDetailQuery ? {} : { take: 1 }),
					include: {
						InvoiceItems: true,
					},
				},
				coveredPaymentRequests: {
					select: { id: true, BuyerWallet: { select: { walletVkey: true } } },
				},
			},
			orderBy: { createdAt: 'desc' },
			...(isDetailQuery ? {} : { take: input.limit }),
		});

		const invoices = invoiceBases.flatMap((base) =>
			base.InvoiceRevisions.map((rev) => {
				let vatTotal = 0;
				let grossTotal = 0;
				for (const item of rev.InvoiceItems) {
					vatTotal += Number(item.vatAmount);
					grossTotal += Number(item.totalAmount);
				}
				const netTotal = grossTotal - vatTotal;

				return {
					id: base.id,
					invoiceId: base.invoiceId,
					createdAt: base.createdAt,
					revisionId: rev.id,
					revisionNumber: rev.revisionNumber,
					revisionCount: base._count.InvoiceRevisions,
					invoiceMonth: base.invoiceMonth,
					invoiceYear: base.invoiceYear,
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
					buyerWalletVkey: base.buyerWalletVkey,
					invoicePdf: Buffer.from(rev.generatedPDFInvoice as unknown as Uint8Array).toString('base64'),
					cancellationInvoicePdf: rev.generatedCancelledInvoice
						? Buffer.from(rev.generatedCancelledInvoice as unknown as Uint8Array).toString('base64')
						: null,
				};
			}),
		);

		return { Invoices: invoices };
	},
});

// ── POST /api/v1/invoice/monthly — Generate invoice (signature-verified) ──

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
