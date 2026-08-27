import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import type { AuthContext } from '@masumi/payment-core/auth';
import type { ReportSummaryInput } from '@/routes/api/reports/schemas';

type AnyMock = Mock<(...args: any[]) => any>;

const mockGetCompleteReportData = jest.fn() as AnyMock;
const mockCreateTransactionsCsv = jest.fn() as AnyMock;
const mockCreateWalletSummaryCsv = jest.fn() as AnyMock;
const mockCreateTotalsCsv = jest.fn() as AnyMock;
const mockStageReportCsv = jest.fn() as AnyMock;
const mockStageReportZip = jest.fn() as AnyMock;
const mockLoggerError = jest.fn() as AnyMock;
const MOCK_CSV_MAX_BYTES = 64;

class MockReportCsvSizeLimitError extends Error {
	constructor(readonly maxBytes: number) {
		super(`Report CSV exceeds ${maxBytes} bytes. Narrow the report filters.`);
	}
}

jest.unstable_mockModule('./service', () => ({ getCompleteReportData: mockGetCompleteReportData }));
jest.unstable_mockModule('./csv', () => ({
	createTransactionsCsv: mockCreateTransactionsCsv,
	createWalletSummaryCsv: mockCreateWalletSummaryCsv,
	createTotalsCsv: mockCreateTotalsCsv,
	REPORT_CSV_MAX_BYTES: MOCK_CSV_MAX_BYTES,
	ReportCsvSizeLimitError: MockReportCsvSizeLimitError,
}));
jest.unstable_mockModule('./export-files', () => ({
	stageReportCsv: mockStageReportCsv,
	stageReportZip: mockStageReportZip,
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({ logger: { error: mockLoggerError } }));

const { createReportExport } = await import('./export-service');

const input = {
	paymentSourceId: 'source-1',
	roles: ['Buyer', 'Seller'],
	states: [],
	from: new Date('2026-01-01T00:00:00.000Z'),
	to: new Date('2026-02-01T00:00:00.000Z'),
	dateBasis: 'RevenueRecognizedAt',
	revenueMode: 'Billable',
	timeZone: 'Etc/UTC',
	bucket: 'Day',
} satisfies ReportSummaryInput;

const ctx = { id: 'api-key-1', canRead: true } as AuthContext;
const transactions = Buffer.from('transactions');
const walletSummary = Buffer.from('wallet-summary');
const totals = Buffer.from('totals');
const report = {
	rows: [{ id: 'row-1' }],
	aggregate: { totals: {}, wallets: [], bucket: 'Day' },
	metadata: {
		generatedAt: new Date('2026-08-24T12:34:56.789Z'),
		asOf: new Date('2026-08-24T12:00:00.000Z'),
		paymentSource: {
			id: 'source-1',
			network: 'Preprod',
			paymentSourceType: 'Web3CardanoV1',
			feeRatePermille: 50,
			smartContractAddress: 'addr_test1w',
			deletedAt: null,
		},
		filters: {
			paymentSourceId: 'source-1',
			managedWalletIds: null,
			externalAddresses: [],
			roles: ['Buyer', 'Seller'],
			states: [],
			from: new Date('2026-08-01T00:00:00.000Z'),
			to: new Date('2026-08-24T00:00:00.000Z'),
			dateBasis: 'CreatedAt',
			revenueMode: 'Billable',
			timeZone: 'Etc/UTC',
		},
		fiat: null,
		warnings: [],
	},
};
const artifact = {
	filePath: '/tmp/report.csv',
	filename: 'report.csv',
	contentType: 'text/csv; charset=utf-8',
	contentLength: 10,
	cleanup: jest.fn(),
};

describe('createReportExport', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockGetCompleteReportData.mockResolvedValue(report);
		mockCreateTransactionsCsv.mockReturnValue(transactions);
		mockCreateWalletSummaryCsv.mockReturnValue(walletSummary);
		mockCreateTotalsCsv.mockReturnValue(totals);
		mockStageReportCsv.mockResolvedValue(artifact);
		mockStageReportZip.mockResolvedValue({ ...artifact, filename: 'report.zip', contentType: 'application/zip' });
	});

	it.each([
		['transactions', transactions, mockCreateTransactionsCsv, 'masumi-transactions-20260824T123456Z'],
		['wallet-summary', walletSummary, mockCreateWalletSummaryCsv, 'masumi-wallet-summary-20260824T123456Z'],
		['totals', totals, mockCreateTotalsCsv, 'masumi-totals-20260824T123456Z'],
	] as const)('stages the direct %s CSV from one report snapshot', async (kind, expected, generator, baseName) => {
		const result = await createReportExport(input, ctx, kind);

		expect(result).toBe(artifact);
		expect(mockGetCompleteReportData).toHaveBeenCalledWith(input, ctx, undefined);
		expect(mockGetCompleteReportData).toHaveBeenCalledTimes(1);
		expect(generator).toHaveBeenCalledWith(
			kind === 'transactions' ? report.rows : report.aggregate,
			expect.objectContaining({ requestedBucket: 'Day', bucket: 'Day' }),
		);
		expect(mockStageReportCsv).toHaveBeenCalledWith(expected, baseName);
		expect(mockStageReportZip).not.toHaveBeenCalled();
	});

	it('stages one ZIP from the same three CSV buffers, alongside the README', async () => {
		await createReportExport(input, ctx, 'zip');

		expect(mockGetCompleteReportData).toHaveBeenCalledTimes(1);
		expect(mockCreateTransactionsCsv).toHaveBeenCalledWith(
			report.rows,
			expect.objectContaining({
				requestedBucket: 'Day',
				bucket: 'Day',
			}),
			{
				maxBytes: MOCK_CSV_MAX_BYTES,
			},
		);
		expect(mockCreateWalletSummaryCsv).toHaveBeenCalledWith(
			report.aggregate,
			expect.objectContaining({
				requestedBucket: 'Day',
				bucket: 'Day',
			}),
			{
				maxBytes: MOCK_CSV_MAX_BYTES - transactions.byteLength,
			},
		);
		expect(mockCreateTotalsCsv).toHaveBeenCalledWith(
			report.aggregate,
			expect.objectContaining({
				requestedBucket: 'Day',
				bucket: 'Day',
			}),
			{
				maxBytes: MOCK_CSV_MAX_BYTES - transactions.byteLength - walletSummary.byteLength,
			},
		);
		expect(mockStageReportZip).toHaveBeenCalledWith(
			expect.objectContaining({ transactions, walletSummary, totals }),
			'masumi-transaction-report-20260824T123456Z',
		);
		const [zipFiles] = mockStageReportZip.mock.calls[0] as [{ readme: Buffer }];
		expect(zipFiles.readme.toString('utf8')).toContain('# Masumi transaction report');
		expect(mockStageReportCsv).not.toHaveBeenCalled();
	});

	it('rejects a ZIP when its combined CSV members exceed the byte limit', async () => {
		const oversizedTransactions = Buffer.alloc(40);
		const oversizedWalletSummary = Buffer.alloc(20);
		const oversizedTotals = Buffer.alloc(5);
		mockCreateTransactionsCsv.mockReturnValue(oversizedTransactions);
		mockCreateWalletSummaryCsv.mockReturnValue(oversizedWalletSummary);
		mockCreateTotalsCsv.mockReturnValue(oversizedTotals);

		await expect(createReportExport(input, ctx, 'zip')).rejects.toMatchObject({
			statusCode: 413,
			expose: true,
			message: 'Report CSV exceeds 64 bytes. Narrow the report filters.',
		});
		expect(mockCreateTotalsCsv).toHaveBeenCalledWith(
			report.aggregate,
			expect.objectContaining({ requestedBucket: 'Day', bucket: 'Day' }),
			{ maxBytes: 4 },
		);
		expect(mockStageReportZip).not.toHaveBeenCalled();
	});

	it('cleans up a staged ZIP when archive overhead exceeds the byte limit', async () => {
		const cleanup = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
		mockStageReportZip.mockResolvedValue({
			...artifact,
			contentLength: MOCK_CSV_MAX_BYTES + 1,
			cleanup,
		});

		await expect(createReportExport(input, ctx, 'zip')).rejects.toMatchObject({
			statusCode: 413,
			expose: true,
			message: 'Report CSV exceeds 64 bytes. Narrow the report filters.',
		});
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	it('maps the CSV byte limit to a public 413 response', async () => {
		mockCreateTransactionsCsv.mockImplementation(() => {
			throw new MockReportCsvSizeLimitError(64);
		});

		await expect(createReportExport(input, ctx, 'transactions')).rejects.toMatchObject({
			statusCode: 413,
			expose: true,
			message: 'Report CSV exceeds 64 bytes. Narrow the report filters.',
		});
		expect(mockStageReportCsv).not.toHaveBeenCalled();
	});

	it('rejects before CSV work when report loading exhausts the export deadline', async () => {
		const now = jest.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(31_000);

		await expect(createReportExport(input, ctx, 'transactions')).rejects.toMatchObject({
			statusCode: 504,
			expose: false,
			message: 'Report export timed out. Narrow the report filters.',
		});
		expect(mockCreateTransactionsCsv).not.toHaveBeenCalled();
		expect(mockStageReportCsv).not.toHaveBeenCalled();
		now.mockRestore();
	});

	it('rejects before report loading when the request is already aborted', async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(createReportExport(input, ctx, 'transactions', controller.signal)).rejects.toMatchObject({
			statusCode: 504,
			message: 'Report export timed out. Narrow the report filters.',
		});
		expect(mockGetCompleteReportData).not.toHaveBeenCalled();
		expect(mockCreateTransactionsCsv).not.toHaveBeenCalled();
	});

	it('stops before CSV work when the request aborts during report loading', async () => {
		const controller = new AbortController();
		let resolveReport!: (value: typeof report) => void;
		mockGetCompleteReportData.mockReturnValue(
			new Promise<typeof report>((resolve) => {
				resolveReport = resolve;
			}),
		);
		const result = createReportExport(input, ctx, 'transactions', controller.signal);

		controller.abort();
		resolveReport(report);
		await expect(result).rejects.toMatchObject({ statusCode: 504 });
		expect(mockGetCompleteReportData).toHaveBeenCalledWith(input, ctx, controller.signal);
		expect(mockCreateTransactionsCsv).not.toHaveBeenCalled();
	});

	it('returns 504 at the export deadline and tracks report loading until it settles', async () => {
		jest.useFakeTimers();
		let resolveReport!: (value: typeof report) => void;
		const pendingReport = new Promise<typeof report>((resolve) => {
			resolveReport = resolve;
		});
		mockGetCompleteReportData.mockReturnValue(pendingReport);
		const trackPendingWork = jest.fn<(work: Promise<unknown>) => void>();
		let outcome: unknown = 'pending';
		const result = createReportExport(input, ctx, 'transactions', undefined, trackPendingWork);
		void result.then(
			(value) => {
				outcome = value;
			},
			(error: unknown) => {
				outcome = error;
			},
		);

		await jest.advanceTimersByTimeAsync(30_000);
		await Promise.resolve();
		const outcomeAtDeadline = outcome;
		resolveReport(report);
		await result.catch(() => undefined);
		jest.useRealTimers();

		expect(outcomeAtDeadline).toMatchObject({ statusCode: 504 });
		expect(trackPendingWork).toHaveBeenCalledWith(pendingReport);
		expect(mockCreateTransactionsCsv).not.toHaveBeenCalled();
	});

	it('cleans a staging result that resolves after the export timeout', async () => {
		jest.useFakeTimers();
		let resolveArtifact!: (value: typeof artifact) => void;
		const pendingArtifact = new Promise<typeof artifact>((resolve) => {
			resolveArtifact = resolve;
		});
		mockStageReportCsv.mockReturnValue(pendingArtifact);
		const result = createReportExport(input, ctx, 'transactions');
		const rejection = expect(result).rejects.toMatchObject({ statusCode: 504 });
		await Promise.resolve();

		await jest.advanceTimersByTimeAsync(30_000);
		await rejection;
		resolveArtifact(artifact);
		await jest.runAllTimersAsync();
		await Promise.resolve();
		expect(artifact.cleanup).toHaveBeenCalledTimes(1);
		jest.useRealTimers();
	});

	it('stops waiting for staging and cleans its late result after a request abort', async () => {
		let resolveArtifact!: (value: typeof artifact) => void;
		mockStageReportCsv.mockReturnValue(
			new Promise<typeof artifact>((resolve) => {
				resolveArtifact = resolve;
			}),
		);
		const controller = new AbortController();
		const result = createReportExport(input, ctx, 'transactions', controller.signal);
		for (let attempt = 0; attempt < 5 && mockStageReportCsv.mock.calls.length === 0; attempt += 1) {
			await Promise.resolve();
		}
		expect(mockStageReportCsv).toHaveBeenCalledTimes(1);
		controller.abort();

		const settledResult = result.catch((error: unknown) => error);
		const outcome = await Promise.race([
			settledResult,
			new Promise<'still-pending'>((resolve) => setImmediate(() => resolve('still-pending'))),
		]);
		resolveArtifact(artifact);
		await settledResult;
		await Promise.resolve();
		await Promise.resolve();

		expect(outcome).toMatchObject({ statusCode: 504 });
		expect(artifact.cleanup).toHaveBeenCalledTimes(1);
	});

	it('cleans a staged artifact when staging exhausts the export deadline', async () => {
		const cleanup = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
		mockStageReportCsv.mockResolvedValue({ ...artifact, cleanup });
		const now = jest
			.spyOn(Date, 'now')
			.mockReturnValueOnce(1_000)
			.mockReturnValueOnce(1_001)
			.mockReturnValueOnce(1_002)
			.mockReturnValueOnce(1_003)
			.mockReturnValueOnce(1_004)
			.mockReturnValueOnce(31_000);

		await expect(createReportExport(input, ctx, 'transactions')).rejects.toMatchObject({
			statusCode: 504,
			expose: false,
			message: 'Report export timed out. Narrow the report filters.',
		});
		expect(cleanup).toHaveBeenCalledTimes(1);
		now.mockRestore();
	});
});
