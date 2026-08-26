import { jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import type { Mock } from 'jest-mock';
import { testEndpoint } from 'express-zod-api';
import createHttpError from 'http-errors';
import { ApiKeyStatus, Network, PaymentSourceType } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindApiKey = jest.fn() as AnyMock;
const mockGetFacets = jest.fn() as AnyMock;
const mockGetTransactions = jest.fn() as AnyMock;
const mockGetSummary = jest.fn() as AnyMock;
const mockCreateReportExport = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { apiKey: { findUnique: mockFindApiKey } },
}));

jest.unstable_mockModule('@/services/transaction-report/service', () => ({
	getReportFacets: mockGetFacets,
	getTransactionsReport: mockGetTransactions,
	getSummaryReport: mockGetSummary,
}));

jest.unstable_mockModule('@/services/transaction-report/export-service', () => ({
	createReportExport: mockCreateReportExport,
}));

const {
	reportExportZipEndpointPost,
	reportFacetsEndpointGet,
	reportSummaryEndpointPost,
	reportTotalsCsvEndpointPost,
	reportTransactionsCsvEndpointPost,
	reportTransactionsEndpointPost,
	reportWalletSummaryCsvEndpointPost,
} = await import('./index');

const generatedAt = new Date('2026-02-02T00:00:00.000Z');
const source = {
	id: 'source-1',
	network: Network.Preprod,
	paymentSourceType: PaymentSourceType.Web3CardanoV2,
	feeRatePermille: 0,
	smartContractAddress: 'addr_test1contract',
	deletedAt: null,
};

function apiKey(id = 'api-key-1') {
	return {
		id,
		canRead: true,
		canPay: false,
		canAdmin: false,
		status: ApiKeyStatus.Active,
		token: null,
		tokenHash: null,
		tokenHashSecure: 'pbkdf2-placeholder',
		usageLimited: false,
		networkLimit: [Network.Preprod],
		caip2NetworkLimit: [],
		walletScopeEnabled: false,
		WalletScopes: [],
		X402WalletScopes: [],
	};
}

function filters() {
	return {
		paymentSourceId: 'source-1',
		managedWalletIds: [],
		externalAddresses: [],
		roles: ['Buyer', 'Seller'],
		states: [],
		from: new Date('2026-01-01T00:00:00.000Z'),
		to: new Date('2026-02-01T00:00:00.000Z'),
		dateBasis: 'CreatedAt',
		revenueMode: 'Billable',
		timeZone: 'Etc/UTC',
	};
}

function metadata() {
	return {
		generatedAt,
		asOf: generatedAt,
		paymentSource: source,
		filters: filters(),
		fiat: null,
		warnings: [],
	};
}

const zeroAmount = {
	unit: 'lovelace',
	rawAmount: '0',
	decimalAmount: '0.000000',
	decimals: 6,
	symbol: 'ADA',
};

function aggregate() {
	const metric = () => ({ amounts: [zeroAmount], completeness: 'complete' });
	return {
		transactionCount: 0,
		transactionCountCompleteness: 'complete',
		sellerGrossRevenue: metric(),
		protocolFees: metric(),
		sellerCardanoFees: metric(),
		actorCardanoFees: metric(),
		sellerNetRevenue: metric(),
		buyerGrossSpend: metric(),
		returnedFunds: metric(),
		buyerCardanoFees: metric(),
		buyerNetSpend: metric(),
		adminCardanoFees: metric(),
		totalCardanoFees: metric(),
	};
}

function reportBody() {
	return {
		paymentSourceId: 'source-1',
		from: '2026-01-01T00:00:00.000Z',
		to: '2026-02-01T00:00:00.000Z',
		dateBasis: 'CreatedAt',
		revenueMode: 'Billable',
		timeZone: 'Etc/UTC',
	};
}

describe('report JSON endpoints', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockFindApiKey.mockResolvedValue(apiKey());
		mockGetFacets.mockResolvedValue({
			fiat: {
				isConfigured: false,
				isDemoKey: false,
				historyDays: null,
				earliestPriceableDate: null,
				currencies: ['usd'],
				modes: ['PeriodAverage'],
				attribution: 'Exchange rates by CoinGecko',
				setupHint: 'Set COINGECKO_API_KEY.',
			},
			paymentSources: [source],
			managedWallets: [
				{
					id: 'wallet-1',
					paymentSourceId: 'source-1',
					type: 'Selling',
					walletAddress: 'addr-wallet',
					walletVkey: 'wallet-vkey',
					collectionAddress: null,
					note: null,
					deletedAt: null,
				},
			],
		});
		mockGetTransactions.mockResolvedValue({
			rows: [],
			page: { nextCursor: null, hasMore: false },
			metadata: metadata(),
		});
		mockGetSummary.mockResolvedValue({
			totals: aggregate(),
			wallets: [],
			history: [],
			bucket: 'Week',
			metadata: metadata(),
		});
	});

	it('exposes active and archived report facets through read authentication', async () => {
		const { responseMock } = await testEndpoint({
			endpoint: reportFacetsEndpointGet,
			requestProps: { method: 'GET', headers: { token: 'valid' } },
			responseOptions: { eventEmitter: EventEmitter },
		});

		expect(responseMock.statusCode).toBe(200);
		expect(responseMock.getHeader('cache-control')).toBe('private, no-store');
		expect(responseMock.getHeader('vary')).toBe('token');
		expect(mockGetFacets).toHaveBeenCalledWith(expect.objectContaining({ canRead: true }), expect.any(AbortSignal));
		expect(responseMock._getJSONData().data.paymentSources[0]).toMatchObject({
			id: 'source-1',
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
		});
	});

	it('parses transaction report dates and applies schema defaults', async () => {
		const { responseMock } = await testEndpoint({
			endpoint: reportTransactionsEndpointPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid', 'content-type': 'application/json' },
				body: reportBody(),
			},
			responseOptions: { eventEmitter: EventEmitter },
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockGetTransactions).toHaveBeenCalledWith(
			expect.objectContaining({
				paymentSourceId: 'source-1',
				from: new Date('2026-01-01T00:00:00.000Z'),
				roles: ['Buyer', 'Seller'],
				limit: 50,
			}),
			expect.objectContaining({ canRead: true }),
			expect.any(AbortSignal),
		);
	});

	it('returns the exact summary shape including admin Cardano fees', async () => {
		const { responseMock } = await testEndpoint({
			endpoint: reportSummaryEndpointPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid', 'content-type': 'application/json' },
				body: reportBody(),
			},
			responseOptions: { eventEmitter: EventEmitter },
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockGetSummary).toHaveBeenCalledWith(
			expect.objectContaining({ paymentSourceId: 'source-1' }),
			expect.objectContaining({ canRead: true }),
			expect.any(AbortSignal),
		);
		expect(responseMock._getJSONData().data.totals.adminCardanoFees).toEqual({
			amounts: [zeroAmount],
			completeness: 'complete',
		});
	});

	it('rejects an invalid range before report work starts', async () => {
		const { responseMock } = await testEndpoint({
			endpoint: reportTransactionsEndpointPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid', 'content-type': 'application/json' },
				body: { ...reportBody(), to: '2025-12-01T00:00:00.000Z' },
			},
			responseOptions: { eventEmitter: EventEmitter },
		});

		expect(responseMock.statusCode).toBe(400);
		expect(mockGetTransactions).not.toHaveBeenCalled();
	});

	it('rate limits report data requests per API key', async () => {
		mockFindApiKey.mockResolvedValue(apiKey('api-key-report-rate'));

		for (let attempt = 0; attempt < 30; attempt += 1) {
			const { responseMock } = await testEndpoint({
				endpoint: reportTransactionsEndpointPost,
				requestProps: {
					method: 'POST',
					headers: { token: 'rate-limited', 'content-type': 'application/json' },
					body: reportBody(),
				},
				responseOptions: { eventEmitter: EventEmitter },
			});
			expect(responseMock.statusCode).toBe(200);
		}

		const { responseMock } = await testEndpoint({
			endpoint: reportSummaryEndpointPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'rate-limited', 'content-type': 'application/json' },
				body: reportBody(),
			},
			responseOptions: { eventEmitter: EventEmitter },
		});

		expect(responseMock.statusCode).toBe(429);
		expect(responseMock.getHeader('retry-after')).toBeDefined();
		expect(mockGetTransactions).toHaveBeenCalledTimes(30);
		expect(mockGetSummary).not.toHaveBeenCalled();
	});

	it('caps concurrent report work for admin API keys', async () => {
		mockFindApiKey.mockResolvedValue({ ...apiKey('api-key-report-admin'), canAdmin: true });
		const summary = {
			totals: aggregate(),
			wallets: [],
			history: [],
			bucket: 'Week',
			metadata: metadata(),
		};
		let resolveSummary!: (value: typeof summary) => void;
		const pendingSummary = new Promise<typeof summary>((resolve) => {
			resolveSummary = resolve;
		});
		let resolveStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			resolveStarted = resolve;
		});
		mockGetSummary.mockImplementation(() => {
			if (mockGetSummary.mock.calls.length === 4) resolveStarted();
			return mockGetSummary.mock.calls.length <= 4 ? pendingSummary : Promise.resolve(summary);
		});
		const request = () =>
			testEndpoint({
				endpoint: reportSummaryEndpointPost,
				requestProps: {
					method: 'POST',
					headers: { token: 'admin', 'content-type': 'application/json' },
					body: reportBody(),
				},
				responseOptions: { eventEmitter: EventEmitter },
			});
		const active = Array.from({ length: 4 }, request);
		await started;
		expect(mockGetSummary).toHaveBeenCalledTimes(4);

		try {
			const blocked = await request();
			expect(blocked.responseMock.statusCode).toBe(503);
			expect(blocked.responseMock.getHeader('retry-after')).toBe('1');
			expect(mockGetSummary).toHaveBeenCalledTimes(4);
		} finally {
			resolveSummary(summary);
			await Promise.all(active);
		}
	});
});

describe('report export endpoints', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockFindApiKey.mockResolvedValue(apiKey());
		mockCreateReportExport.mockRejectedValue(createHttpError(503, 'staging unavailable'));
	});

	it.each([
		['transactions', reportTransactionsCsvEndpointPost],
		['wallet-summary', reportWalletSummaryCsvEndpointPost],
		['totals', reportTotalsCsvEndpointPost],
		['zip', reportExportZipEndpointPost],
	] as const)('creates the %s export from the parsed report filters', async (kind, endpoint) => {
		const { responseMock } = await testEndpoint({
			endpoint,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid', 'content-type': 'application/json' },
				body: reportBody(),
			},
			responseOptions: { eventEmitter: EventEmitter },
		});

		expect(responseMock.statusCode).toBe(503);
		expect(mockCreateReportExport).toHaveBeenCalledWith(
			expect.objectContaining({
				paymentSourceId: 'source-1',
				from: new Date('2026-01-01T00:00:00.000Z'),
				roles: ['Buyer', 'Seller'],
			}),
			expect.objectContaining({ canRead: true }),
			kind,
			expect.any(AbortSignal),
			expect.any(Function),
		);
	});

	it('cleans an invalid staged artifact after endpoint output pass-through', async () => {
		const cleanup = jest.fn(async () => undefined);
		mockCreateReportExport.mockResolvedValue({
			filePath: '/private/tmp/staged-report.csv',
			filename: 'bad\r\nInjected.csv',
			contentType: 'text/csv; charset=utf-8',
			contentLength: 12,
			cleanup,
		});

		const { responseMock } = await testEndpoint({
			endpoint: reportTransactionsCsvEndpointPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid', 'content-type': 'application/json' },
				body: reportBody(),
			},
			responseOptions: { eventEmitter: EventEmitter },
		});

		expect(responseMock.statusCode).toBe(500);
		expect(responseMock._getJSONData()).toEqual({
			status: 'error',
			error: { message: expect.any(String) },
		});
		expect(responseMock.getHeader('content-disposition')).toBeUndefined();
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	it('rate limits report exports per API key', async () => {
		mockFindApiKey.mockResolvedValue(apiKey('api-key-export-rate'));

		for (let attempt = 0; attempt < 5; attempt += 1) {
			const { responseMock } = await testEndpoint({
				endpoint: reportTotalsCsvEndpointPost,
				requestProps: {
					method: 'POST',
					headers: { token: 'export-rate-limited', 'content-type': 'application/json' },
					body: reportBody(),
				},
				responseOptions: { eventEmitter: EventEmitter },
			});
			expect(responseMock.statusCode).toBe(503);
		}

		const { responseMock } = await testEndpoint({
			endpoint: reportExportZipEndpointPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'export-rate-limited', 'content-type': 'application/json' },
				body: reportBody(),
			},
			responseOptions: { eventEmitter: EventEmitter },
		});

		expect(responseMock.statusCode).toBe(429);
		expect(responseMock.getHeader('retry-after')).toBeDefined();
		expect(mockCreateReportExport).toHaveBeenCalledTimes(5);
	});
});
