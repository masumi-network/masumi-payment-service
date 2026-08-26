// Colocated OpenAPI docs for this route area. When you add or change an
// endpoint here, update THIS file in the same PR. CI checks generated docs.
import { z } from '@masumi/payment-core/zod';
import {
	reportFacetsOutputSchema,
	reportSummaryInputSchema,
	reportSummaryOutputSchema,
	reportTransactionsInputSchema,
	reportTransactionsOutputSchema,
} from '@/routes/api/reports/schemas';
import { REPORT_CSV_CONTENT_TYPE, REPORT_ZIP_CONTENT_TYPE } from '@/services/transaction-report/export-files';
import { successResponse, type SwaggerRegistrarContext } from '@/utils/generator/swagger-generator/shared';

const reportFilterExample = {
	paymentSourceId: 'payment_source_id',
	managedWalletIds: ['managed_wallet_id'],
	externalAddresses: ['addr_test1_external'],
	roles: ['Buyer', 'Seller'],
	states: ['FundsLocked', 'Withdrawn'],
	from: '2026-01-01T00:00:00.000Z',
	to: '2026-02-01T00:00:00.000Z',
	dateBasis: 'RevenueRecognizedAt',
	revenueMode: 'Billable',
	timeZone: 'Etc/UTC',
};

const paymentSourceExample = {
	id: 'payment_source_id',
	network: 'Preprod',
	paymentSourceType: 'Web3CardanoV2',
	feeRatePermille: 0,
	smartContractAddress: 'addr_test1_contract',
	deletedAt: null,
};

const managedWalletExample = {
	id: 'managed_wallet_id',
	walletAddress: 'addr_test1_wallet',
	walletVkey: 'wallet_verification_key',
	collectionAddress: null,
	deletedAt: null,
};

const metadataExample = {
	generatedAt: '2026-02-01T00:00:01.000Z',
	asOf: '2026-02-01T00:00:00.000Z',
	paymentSource: paymentSourceExample,
	filters: {
		...reportFilterExample,
		managedWalletIds: ['managed_wallet_id'],
		externalAddresses: ['addr_test1_external'],
	},
	warnings: [],
};

const zeroAdaExample = {
	unit: 'lovelace',
	rawAmount: '0',
	decimalAmount: '0.000000',
	decimals: 6,
	symbol: 'ADA',
};

const aggregateMetricExample = {
	amounts: [zeroAdaExample],
	completeness: 'complete',
};

const aggregateExample = {
	transactionCount: 0,
	transactionCountCompleteness: 'complete',
	sellerGrossRevenue: aggregateMetricExample,
	protocolFees: aggregateMetricExample,
	sellerCardanoFees: aggregateMetricExample,
	actorCardanoFees: aggregateMetricExample,
	sellerNetRevenue: aggregateMetricExample,
	buyerGrossSpend: aggregateMetricExample,
	returnedFunds: aggregateMetricExample,
	buyerCardanoFees: aggregateMetricExample,
	buyerNetSpend: aggregateMetricExample,
	adminCardanoFees: aggregateMetricExample,
	totalCardanoFees: aggregateMetricExample,
};

const reportErrorResponseSchema = z.object({
	status: z.literal('error'),
	error: z.object({ message: z.string() }),
});

function jsonErrorResponse(description: string) {
	return {
		description,
		content: {
			'application/json': { schema: reportErrorResponseSchema.openapi({}) },
		},
	};
}

function retryableJsonErrorResponse(description: string) {
	return {
		...jsonErrorResponse(description),
		headers: {
			'Retry-After': {
				description: 'Minimum seconds before another report request',
				schema: { type: 'integer' as const, minimum: 1 },
			},
		},
	};
}

const reportAdmissionErrors = {
	429: retryableJsonErrorResponse('The API key exceeded its report request rate'),
	503: retryableJsonErrorResponse('All report processing slots are in use'),
};

const reportErrors = {
	...reportAdmissionErrors,
	400: jsonErrorResponse('The report filters or cursor are invalid'),
	401: jsonErrorResponse('Unauthorized'),
	404: jsonErrorResponse('The payment source or requested managed wallet is not accessible'),
	502: jsonErrorResponse('The exchange rate provider could not price a requested asset'),
	504: jsonErrorResponse('The report calculation timed out; narrow the filters'),
};

const completeReportErrors = {
	...reportErrors,
	413: jsonErrorResponse('The report exceeds its row or file size limit; narrow the filters'),
};

function jsonRequest(schema: z.ZodTypeAny, example: unknown, description: string) {
	return {
		body: {
			required: true,
			description,
			content: {
				'application/json': {
					schema: schema.openapi({ example }),
				},
			},
		},
	};
}

function binaryResponse(description: string, contentType: string) {
	return {
		description,
		headers: {
			'Content-Disposition': {
				description: 'Attachment filename, including an RFC 5987 UTF-8 filename',
				schema: { type: 'string' as const },
			},
			'Content-Length': {
				description: 'Artifact size in bytes',
				schema: { type: 'integer' as const, format: 'int64', minimum: 0 },
			},
		},
		content: {
			[contentType]: {
				schema: { type: 'string' as const, format: 'binary' },
			},
		},
	};
}

export function registerReportPaths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	const secured = [{ [apiKeyAuth.name]: [] }];
	const summaryInputExample = { ...reportFilterExample, bucket: 'Auto' };

	registry.registerPath({
		method: 'get',
		path: '/reports/facets',
		description:
			'Lists accessible payment sources and their managed buyer and seller wallets. Results include archived records so historical reports can retain their original labels.',
		summary: 'List transaction report filters. (read access required)',
		tags: ['reports'],
		security: secured,
		responses: {
			200: successResponse('Accessible report filters', reportFacetsOutputSchema, {
				paymentSources: [paymentSourceExample],
				managedWallets: [
					{
						...managedWalletExample,
						paymentSourceId: paymentSourceExample.id,
						type: 'Selling',
						note: 'Primary seller wallet',
					},
				],
			}),
			...reportAdmissionErrors,
			401: reportErrors[401],
			413: completeReportErrors[413],
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/reports/transactions',
		description:
			'Returns paginated buyer and seller report rows for one payment source. The cursor preserves the initial asOf boundary and source fee settings, but it does not preserve historical row values. Amounts include raw atomic units and decimal metadata for supported assets.',
		summary: 'Get transaction report rows. (read access required)',
		tags: ['reports'],
		security: secured,
		request: jsonRequest(
			reportTransactionsInputSchema,
			{ ...reportFilterExample, limit: 50 },
			'Payment source, wallet, role, state, accounting date, revenue, and pagination filters',
		),
		responses: {
			200: successResponse('Transaction report rows', reportTransactionsOutputSchema, {
				rows: [],
				page: { nextCursor: null, hasMore: false },
				metadata: metadataExample,
			}),
			...reportErrors,
			413: completeReportErrors[413],
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/reports/summary',
		description:
			'Returns totals, per-wallet and role totals, and time buckets from one database snapshot. The service calculates applicable V1 protocol fees from the payment source rate. Applicable V2 protocol fees are exact zero.',
		summary: 'Get transaction report totals and history. (read access required)',
		tags: ['reports'],
		security: secured,
		request: jsonRequest(reportSummaryInputSchema, summaryInputExample, 'Report filters and history bucket size'),
		responses: {
			200: successResponse('Transaction report totals and history', reportSummaryOutputSchema, {
				totals: aggregateExample,
				wallets: [],
				history: [],
				bucket: 'Day',
				metadata: metadataExample,
			}),
			...completeReportErrors,
		},
	});

	for (const exportPath of [
		{
			path: '/reports/transactions.csv',
			description: 'Downloads one row per buyer or seller transaction as CSV.',
			responseDescription: 'Transaction rows CSV',
			contentType: REPORT_CSV_CONTENT_TYPE,
		},
		{
			path: '/reports/wallet-summary.csv',
			description: 'Downloads totals grouped by managed wallet and buyer or seller role as CSV.',
			responseDescription: 'Wallet and role totals CSV',
			contentType: REPORT_CSV_CONTENT_TYPE,
		},
		{
			path: '/reports/totals.csv',
			description: 'Downloads payment source totals as CSV.',
			responseDescription: 'Payment source totals CSV',
			contentType: REPORT_CSV_CONTENT_TYPE,
		},
		{
			path: '/reports/export.zip',
			description:
				'Downloads a ZIP archive containing transactions.csv, wallet-summary.csv, and totals.csv from one database snapshot.',
			responseDescription: 'Complete transaction report ZIP archive',
			contentType: REPORT_ZIP_CONTENT_TYPE,
		},
	] as const) {
		registry.registerPath({
			method: 'post',
			path: exportPath.path,
			description: exportPath.description,
			summary: `${exportPath.responseDescription}. (read access required)`,
			tags: ['reports'],
			security: secured,
			request: jsonRequest(reportSummaryInputSchema, summaryInputExample, 'Report filters and history bucket size'),
			responses: {
				200: binaryResponse(exportPath.responseDescription, exportPath.contentType),
				...completeReportErrors,
			},
		});
	}
}
