import { readAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { createReportExport } from '@/services/transaction-report/export-service';
import { getReportFacets, getSummaryReport, getTransactionsReport } from '@/services/transaction-report/service';
import { createAuthenticatedRateLimitMiddleware } from '@/utils/middleware/rate-limit';
import {
	readAuthenticatedReportExportEndpointFactory,
	reportExportArtifactPassThroughSchema,
} from './export-result-handler';
import {
	reportFacetsOutputSchema,
	reportSummaryInputSchema,
	reportSummaryOutputSchema,
	reportTransactionsInputSchema,
	reportTransactionsOutputSchema,
} from './schemas';
import { privateReportResponseMiddleware, reportAbortMiddleware, reportConcurrencyMiddleware } from './request-control';

const reportFacetsInputSchema = z.object({});
const reportDataRateLimitMiddleware = createAuthenticatedRateLimitMiddleware({
	maxRequests: 30,
	windowMs: 60_000,
});
const reportExportRateLimitMiddleware = createAuthenticatedRateLimitMiddleware({
	maxRequests: 5,
	windowMs: 60_000,
});
const reportEndpointFactory = readAuthenticatedEndpointFactory
	.addMiddleware(privateReportResponseMiddleware)
	.addMiddleware(reportDataRateLimitMiddleware)
	.addMiddleware(reportAbortMiddleware)
	.addMiddleware(reportConcurrencyMiddleware);
const reportExportEndpointFactory = readAuthenticatedReportExportEndpointFactory
	// Export errors are JSON like the data endpoints and depend on the token, so
	// they need the same Cache-Control and Vary. The success path sets its own
	// no-store, but only after this middleware has already covered the failures.
	.addMiddleware(privateReportResponseMiddleware)
	.addMiddleware(reportExportRateLimitMiddleware)
	.addMiddleware(reportAbortMiddleware)
	.addMiddleware(reportConcurrencyMiddleware);

export const reportFacetsEndpointGet = reportEndpointFactory.build({
	method: 'get',
	input: reportFacetsInputSchema,
	output: reportFacetsOutputSchema,
	handler: async ({ ctx }) => ctx.runReportOperation(() => getReportFacets(ctx, ctx.reportAbortSignal)),
});

export const reportTransactionsEndpointPost = reportEndpointFactory.build({
	method: 'post',
	input: reportTransactionsInputSchema,
	output: reportTransactionsOutputSchema,
	handler: async ({ input, ctx }) =>
		ctx.runReportOperation(() => getTransactionsReport(input, ctx, ctx.reportAbortSignal)),
});

export const reportSummaryEndpointPost = reportEndpointFactory.build({
	method: 'post',
	input: reportSummaryInputSchema,
	output: reportSummaryOutputSchema,
	handler: async ({ input, ctx }) => ctx.runReportOperation(() => getSummaryReport(input, ctx, ctx.reportAbortSignal)),
});

function buildReportExportEndpoint(kind: 'transactions' | 'wallet-summary' | 'totals' | 'zip') {
	return reportExportEndpointFactory.build({
		method: 'post',
		input: reportSummaryInputSchema,
		output: reportExportArtifactPassThroughSchema,
		handler: async ({ input, ctx }) =>
			ctx.runReportOperation((trackPendingWork) =>
				createReportExport(input, ctx, kind, ctx.reportAbortSignal, trackPendingWork),
			),
	});
}

export const reportTransactionsCsvEndpointPost = buildReportExportEndpoint('transactions');
export const reportWalletSummaryCsvEndpointPost = buildReportExportEndpoint('wallet-summary');
export const reportTotalsCsvEndpointPost = buildReportExportEndpoint('totals');
export const reportExportZipEndpointPost = buildReportExportEndpoint('zip');

export {
	reportFacetsOutputSchema,
	reportSummaryInputSchema,
	reportSummaryOutputSchema,
	reportTransactionsInputSchema,
	reportTransactionsOutputSchema,
};
