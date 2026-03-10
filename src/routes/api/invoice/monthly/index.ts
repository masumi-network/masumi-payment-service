import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { z } from '@/utils/zod-openapi';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';

import stringify from 'canonical-json';
import { recordBusinessEndpointError } from '@/utils/metrics';
import { checkSignature } from '@meshsdk/core';
import { generateHash } from '@/utils/crypto';
import { AuthContext } from '@/utils/middleware/auth-middleware';
import { generateMonthlyInvoice } from './shared';
import { buildWalletScopeFilter } from '@/utils/shared/wallet-scope';
import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import {
	getMonthlyInvoiceListSchemaInput,
	getMonthlyInvoiceListSchemaOutput,
	postGenerateMonthlyInvoiceSchemaInput,
	postGenerateMonthlyInvoiceSchemaOutput,
} from './schemas';

export {
	getMonthlyInvoiceListSchemaInput,
	getMonthlyInvoiceListSchemaOutput,
	postGenerateMonthlyInvoiceSchemaInput,
	postGenerateMonthlyInvoiceSchemaOutput,
};

// ── GET /api/v1/invoice/monthly — List invoices ──

export const getMonthlyInvoiceListEndpoint = readAuthenticatedEndpointFactory.build({
	method: 'get',
	input: getMonthlyInvoiceListSchemaInput,
	output: getMonthlyInvoiceListSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof getMonthlyInvoiceListSchemaInput>; ctx: AuthContext }) => {
		const [yearStr, monthStr] = input.month.split('-');
		const year = Number(yearStr);
		const monthNum = Number(monthStr);

		const isDetailQuery = !!input.invoiceBaseId;

		const walletScopePaymentFilter = buildWalletScopeFilter(ctx.walletScopeIds);
		const invoiceBases = await prisma.invoiceBase.findMany({
			where: {
				...(isDetailQuery
					? { id: input.invoiceBaseId }
					: {
							invoiceMonth: monthNum,
							invoiceYear: year,
							...(input.cursorId ? { id: { lt: input.cursorId } } : {}),
						}),
				...(ctx.walletScopeIds !== null ? { coveredPaymentRequests: { some: walletScopePaymentFilter } } : {}),
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

				const firstItemVatRate = rev.InvoiceItems.length > 0 ? Number(rev.InvoiceItems[0].vatRate) : null;

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
					reverseCharge: rev.reverseCharge,
					language: rev.language,
					localizationFormat: rev.localizationFormat,
					vatRate: firstItemVatRate,
					sellerName: rev.sellerName,
					sellerCompanyName: rev.sellerCompanyName,
					sellerVatNumber: rev.sellerVatNumber,
					sellerCountry: rev.sellerCountry,
					sellerCity: rev.sellerCity,
					sellerZipCode: rev.sellerZipCode,
					sellerStreet: rev.sellerStreet,
					sellerStreetNumber: rev.sellerStreetNumber,
					sellerEmail: rev.sellerEmail,
					sellerPhone: rev.sellerPhone,
					buyerName: rev.buyerName,
					buyerCompanyName: rev.buyerCompanyName,
					buyerVatNumber: rev.buyerVatNumber,
					buyerCountry: rev.buyerCountry,
					buyerCity: rev.buyerCity,
					buyerZipCode: rev.buyerZipCode,
					buyerStreet: rev.buyerStreet,
					buyerStreetNumber: rev.buyerStreetNumber,
					buyerEmail: rev.buyerEmail,
					buyerPhone: rev.buyerPhone,
					invoiceTitle: rev.invoiceTitle,
					invoiceDescription: rev.invoiceDescription,
					isCancelled: rev.isCancelled,
					cancellationReason: rev.cancellationReason,
					cancellationDate: rev.cancellationDate,
					cancellationId: rev.cancellationId,
					itemCount: rev.InvoiceItems.length,
					netTotal: netTotal.toFixed(2),
					vatTotal: vatTotal.toFixed(2),
					grossTotal: grossTotal.toFixed(2),
					CoveredPaymentRequestIds: base.coveredPaymentRequests.map((p) => p.id),
					buyerWalletVkey: base.buyerWalletVkey,
					sellerWalletVkey: base.sellerWalletVkey,
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

export const postGenerateMonthlyInvoiceEndpoint = payAuthenticatedEndpointFactory.build({
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
				throw createHttpError(400, 'Signature is too far in the future');
			}

			const message = stringify({
				Buyer: input.Buyer,
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
					walletAddress: input.walletAddress,
					metricPath: '/api/v1/invoice/monthly',
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
