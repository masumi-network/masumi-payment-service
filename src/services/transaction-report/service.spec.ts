import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { Network, PaymentSourceType } from '@/generated/prisma/client';
import type { AuthContext } from '@masumi/payment-core/auth';
import type { ReportRequestRecord } from './records';

type AnyMock = Mock<(...args: any[]) => any>;

const mockResolveSource = jest.fn() as AnyMock;
const mockResolveWalletIds = jest.fn() as AnyMock;
const mockListFacets = jest.fn() as AnyMock;
const mockQueryReportPage = jest.fn() as AnyMock;
const mockQueryReportFeeComponentClosure = jest.fn() as AnyMock;
const mockDecodeCursor = jest.fn() as AnyMock;
const mockEncodeCursor = jest.fn() as AnyMock;
const mockCreateFilterFingerprint = jest.fn() as AnyMock;
const mockCreateCursorSnapshot = jest.fn() as AnyMock;
const mockPrismaTransaction = jest.fn() as AnyMock;
const mockTransactionQueryRaw = jest.fn() as AnyMock;
const transactionClient = { transaction: true, $queryRaw: mockTransactionQueryRaw };
const transactionAsOf = new Date('2026-02-02T12:34:56.000Z');

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { $transaction: mockPrismaTransaction },
}));

jest.unstable_mockModule('./access', () => ({
	resolveAccessibleReportSource: mockResolveSource,
	resolveAuthorizedManagedWalletIds: mockResolveWalletIds,
	listAccessibleReportFacets: mockListFacets,
}));

jest.unstable_mockModule('./query', () => ({
	queryReportPage: mockQueryReportPage,
	queryReportFeeComponentClosure: mockQueryReportFeeComponentClosure,
	decodeReportCursor: mockDecodeCursor,
	encodeReportCursor: mockEncodeCursor,
	createReportFilterFingerprint: mockCreateFilterFingerprint,
	createReportCursorSnapshot: mockCreateCursorSnapshot,
}));

const { getCompleteReportData, getReportFacets, getSummaryReport, getTransactionsReport, loadAllReportRows } =
	await import('./service');

const source = {
	id: 'source-1',
	createdAt: new Date('2025-01-01T00:00:00.000Z'),
	network: Network.Preprod,
	paymentSourceType: PaymentSourceType.Web3CardanoV2,
	smartContractAddress: 'addr_test1contract',
	feeRatePermille: 25,
	deletedAt: new Date('2026-01-01T00:00:00.000Z'),
};

const ctx: AuthContext = {
	id: 'api-key-1',
	canRead: true,
	canPay: false,
	canAdmin: false,
	networkLimit: [Network.Preprod],
	caip2NetworkLimit: null,
	usageLimited: false,
	walletScopeIds: ['wallet-1'],
	x402WalletScopeIds: null,
};

function record(id: string, role: 'Buyer' | 'Seller' = 'Seller'): ReportRequestRecord {
	return {
		id,
		role,
		requestType: role === 'Seller' ? 'PaymentRequest' : 'PurchaseRequest',
		createdAt: new Date('2026-01-02T00:00:00.000Z'),
		blockchainIdentifier: `chain-${id}`,
		agentIdentifier: null,
		agentName: null,
		onChainState: 'Withdrawn',
		metadata: null,
		managedWallet: {
			id: 'wallet-1',
			walletAddress: 'addr-wallet',
			walletVkey: 'wallet-vkey',
			collectionAddress: null,
			deletedAt: null,
		},
		counterpartyAddress: 'addr-counterparty',
		buyerReturnAddress: null,
		sellerReturnAddress: null,
		paymentSourceType: 'Web3CardanoV2',
		configuredFeeRatePermille: 25,
		unlockTime: 0n,
		collateralReturnLovelace: 0n,
		requestedFunds: [{ unit: 'lovelace', amount: 9_007_199_254_740_993n }],
		withdrawnForBuyer: [],
		withdrawnForSeller: [],
		buyerPayoutCompleteness: 'complete',
		sellerPayoutCompleteness: 'complete',
		buyerCardanoFees: 100_000n,
		sellerCardanoFees: 200_000n,
		transactions: [
			{
				id: `tx-${id}`,
				txHash: `hash-${id}`,
				status: 'Confirmed',
				newOnChainState: 'Withdrawn',
				blockTime: 1_767_312_000,
				fees: 400_000n,
			},
		],
		feeAllocationScope: 'single_request',
		isFeeReconciliationOwner: true,
		feeComponentScope: 'complete',
	};
}

function transactionInput() {
	return {
		paymentSourceId: 'source-1',
		managedWalletIds: ['wallet-1', 'wallet-1'],
		externalAddresses: ['addr-counterparty', 'addr-counterparty'],
		roles: ['Seller'] as Array<'Seller'>,
		states: [],
		from: new Date('2026-01-01T00:00:00.000Z'),
		to: new Date('2026-02-01T00:00:00.000Z'),
		dateBasis: 'CreatedAt' as const,
		revenueMode: 'Billable' as const,
		timeZone: 'Etc/UTC',
		limit: 50,
	};
}

function queryFilters() {
	return {
		paymentSourceId: 'source-1',
		paymentSourceType: PaymentSourceType.Web3CardanoV2,
		configuredFeeRatePermille: 25,
		authorizedManagedWalletIds: ['wallet-1'],
		externalAddresses: [],
		roles: ['Seller'] as Array<'Seller'>,
		states: [],
		from: new Date('2026-01-01T00:00:00.000Z'),
		to: new Date('2026-02-01T00:00:00.000Z'),
		dateBasis: 'CreatedAt' as const,
		revenueMode: 'Billable' as const,
		asOf: new Date('2026-02-02T00:00:00.000Z'),
	};
}

describe('transaction report service', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockResolveSource.mockResolvedValue(source);
		mockResolveWalletIds.mockResolvedValue(['wallet-1']);
		mockDecodeCursor.mockReturnValue({ positions: { Buyer: null, Seller: null }, snapshot: null });
		mockCreateFilterFingerprint.mockReturnValue('fingerprint');
		mockCreateCursorSnapshot.mockImplementation((filters, filterFingerprint) => ({
			asOf: filters.asOf,
			paymentSourceId: filters.paymentSourceId,
			paymentSourceType: filters.paymentSourceType,
			feeRatePermille: filters.configuredFeeRatePermille,
			filterFingerprint,
		}));
		mockEncodeCursor.mockImplementation((value) => JSON.stringify(value));
		mockQueryReportFeeComponentClosure.mockImplementation(async (records) => records);
		mockTransactionQueryRaw.mockResolvedValue([{ asOf: transactionAsOf }]);
		mockPrismaTransaction.mockImplementation(async (callback) => callback(transactionClient));
	});

	it('applies effective access filters and returns exact serialized amounts', async () => {
		mockQueryReportPage.mockResolvedValue({ records: [record('seller-1')], nextCursor: null });

		const result = await getTransactionsReport(transactionInput(), ctx);

		expect(mockQueryReportPage).toHaveBeenCalledWith(
			expect.objectContaining({
				paymentSourceId: 'source-1',
				paymentSourceType: PaymentSourceType.Web3CardanoV2,
				authorizedManagedWalletIds: ['wallet-1'],
				externalAddresses: ['addr-counterparty'],
				roles: ['Seller'],
			}),
			{ Buyer: null, Seller: null },
			50,
			transactionClient,
			undefined,
		);
		expect(result.rows[0].seller?.grossRevenue?.[0]).toMatchObject({
			rawAmount: '9007199254740993',
			decimalAmount: '9007199254.740993',
		});
		expect(result.metadata.paymentSource.deletedAt).toEqual(source.deletedAt);
		expect(result.metadata.filters.managedWalletIds).toEqual(['wallet-1']);
		expect(result.metadata.asOf).toEqual(transactionAsOf);
		expect(mockResolveSource).toHaveBeenCalledWith(ctx, 'source-1', transactionClient);
		expect(mockResolveWalletIds).toHaveBeenCalledWith(ctx, 'source-1', ['wallet-1', 'wallet-1'], transactionClient);
		expect(mockTransactionQueryRaw.mock.calls[0][0].join('')).toContain('transaction_timestamp()');
		expect(mockTransactionQueryRaw.mock.invocationCallOrder[0]).toBeLessThan(
			mockResolveSource.mock.invocationCallOrder[0],
		);
		expect(mockPrismaTransaction).toHaveBeenCalledWith(expect.any(Function), {
			isolationLevel: 'RepeatableRead',
			timeout: 15_000,
			maxWait: 5_000,
		});
	});

	it('reuses the signed cursor snapshot and rejects changed filters', async () => {
		const snapshot = {
			asOf: new Date('2026-01-15T00:00:00.000Z'),
			paymentSourceId: 'source-1',
			paymentSourceType: PaymentSourceType.Web3CardanoV1,
			feeRatePermille: 75,
			filterFingerprint: 'snapshot-fingerprint',
		};
		mockDecodeCursor.mockReturnValue({ positions: { Buyer: null, Seller: null }, snapshot });
		mockCreateFilterFingerprint.mockReturnValue('snapshot-fingerprint');
		mockQueryReportPage.mockResolvedValue({ records: [], nextCursor: null });

		const result = await getTransactionsReport({ ...transactionInput(), cursor: 'signed-cursor' }, ctx);

		expect(mockQueryReportPage).toHaveBeenCalledWith(
			expect.objectContaining({
				asOf: snapshot.asOf,
				paymentSourceType: PaymentSourceType.Web3CardanoV1,
				configuredFeeRatePermille: 75,
			}),
			{ Buyer: null, Seller: null },
			50,
			transactionClient,
			undefined,
		);
		expect(result.metadata.asOf).toEqual(snapshot.asOf);
		expect(result.metadata.paymentSource).toMatchObject({
			paymentSourceType: PaymentSourceType.Web3CardanoV1,
			feeRatePermille: 75,
		});

		mockCreateFilterFingerprint.mockReturnValue('changed-fingerprint');
		await expect(
			getTransactionsReport({ ...transactionInput(), cursor: 'signed-cursor', states: ['Disputed'] }, ctx),
		).rejects.toMatchObject({ status: 400 });
		expect(mockQueryReportPage).toHaveBeenCalledTimes(1);
	});

	it('binds the next cursor to the report snapshot', async () => {
		const nextCursor = {
			Buyer: null,
			Seller: { createdAt: new Date('2026-01-02T00:00:00.000Z'), id: 'seller-1' },
		};
		mockQueryReportPage.mockResolvedValue({ records: [record('seller-1')], nextCursor });

		const result = await getTransactionsReport(transactionInput(), ctx);

		expect(mockEncodeCursor).toHaveBeenCalledWith({
			positions: nextCursor,
			snapshot: expect.objectContaining({
				paymentSourceId: 'source-1',
				filterFingerprint: 'fingerprint',
			}),
		});
		expect(result.page.hasMore).toBe(true);
		expect(result.metadata.warnings).toContainEqual(
			expect.objectContaining({ code: 'PAGINATED_REPORT_MONOTONIC_SNAPSHOT' }),
		);
	});

	it('keeps shared fee reconciliation stable across paginated JSON and complete exports', async () => {
		const relatedRequestKeys = ['Seller:shared-a', 'Seller:shared-b'];
		const relatedPaymentKeys = ['chain-shared-a', 'chain-shared-b'];
		const sharedTransaction = {
			id: 'tx-shared',
			txHash: 'hash-shared',
			status: 'Confirmed' as const,
			newOnChainState: 'Withdrawn' as const,
			blockTime: 1_767_312_000,
			fees: 500n,
			relatedRequestKeys,
			relatedPaymentKeys,
			relatedPaymentKeysComplete: true,
		};
		const firstRecord = {
			...record('shared-a'),
			blockchainIdentifier: 'chain-shared-a',
			buyerCardanoFees: 0n,
			sellerCardanoFees: 20n,
			transactions: [sharedTransaction],
			feeAllocationScope: 'shared_or_unknown' as const,
			feeComponentScope: 'partial' as const,
		};
		const secondRecord = {
			...record('shared-b'),
			blockchainIdentifier: 'chain-shared-b',
			buyerCardanoFees: 0n,
			sellerCardanoFees: 30n,
			transactions: [sharedTransaction],
			feeAllocationScope: 'shared_or_unknown' as const,
			feeComponentScope: 'partial' as const,
		};
		const nextCursor = {
			Buyer: null,
			Seller: { createdAt: firstRecord.createdAt, id: firstRecord.id },
		};
		mockQueryReportPage
			.mockResolvedValueOnce({ records: [firstRecord], nextCursor })
			.mockResolvedValueOnce({ records: [secondRecord], nextCursor: null })
			.mockResolvedValueOnce({ records: [firstRecord, secondRecord], nextCursor: null });
		mockQueryReportFeeComponentClosure.mockResolvedValue([firstRecord, secondRecord]);

		const firstPage = await getTransactionsReport({ ...transactionInput(), limit: 1 }, ctx);
		mockDecodeCursor.mockReturnValue({
			positions: nextCursor,
			snapshot: {
				asOf: transactionAsOf,
				paymentSourceId: source.id,
				paymentSourceType: source.paymentSourceType,
				feeRatePermille: source.feeRatePermille,
				filterFingerprint: 'fingerprint',
			},
		});
		const secondPage = await getTransactionsReport({ ...transactionInput(), cursor: 'signed-cursor', limit: 1 }, ctx);
		const complete = await getCompleteReportData({ ...transactionInput(), bucket: 'Day' }, ctx);

		expect(firstPage.rows[0].cardanoFeeReconciliation).toMatchObject({
			totalCardanoFees: { rawAmount: '500' },
			adminCardanoFees: null,
			completeness: 'partial',
			isAggregationOwner: true,
		});
		expect(secondPage.rows[0].cardanoFeeReconciliation).toMatchObject({
			totalCardanoFees: null,
			adminCardanoFees: null,
			completeness: 'partial',
			isAggregationOwner: false,
		});
		expect(complete.rows.map((row) => row.cardanoFeeReconciliation)).toEqual([
			expect.objectContaining({ totalCardanoFees: 500n, adminCardanoFees: null, completeness: 'partial' }),
			expect.objectContaining({ totalCardanoFees: null, adminCardanoFees: null, completeness: 'partial' }),
		]);
	});

	it('preserves null metadata when the report includes every accessible wallet', async () => {
		mockResolveWalletIds.mockResolvedValue(null);
		mockQueryReportPage.mockResolvedValue({ records: [], nextCursor: null });
		const { managedWalletIds: _managedWalletIds, ...allWalletInput } = transactionInput();

		const result = await getTransactionsReport(allWalletInput, ctx);

		expect(result.metadata.filters.managedWalletIds).toBeNull();
	});

	it('revalidates source access on a cursor continuation', async () => {
		mockDecodeCursor.mockReturnValue({
			positions: { Buyer: null, Seller: null },
			snapshot: {
				asOf: new Date('2026-01-15T00:00:00.000Z'),
				paymentSourceId: 'source-1',
				paymentSourceType: PaymentSourceType.Web3CardanoV2,
				feeRatePermille: 25,
				filterFingerprint: 'fingerprint',
			},
		});
		mockResolveSource.mockRejectedValue({ status: 404 });

		await expect(getTransactionsReport({ ...transactionInput(), cursor: 'signed-cursor' }, ctx)).rejects.toMatchObject({
			status: 404,
		});
		expect(mockQueryReportPage).not.toHaveBeenCalled();
	});

	it('maps database transaction timeouts to a gateway timeout', async () => {
		mockPrismaTransaction.mockRejectedValue({
			code: 'P2028',
			message: 'Transaction already closed because it exceeded the configured timeout',
		});

		await expect(getTransactionsReport(transactionInput(), ctx)).rejects.toMatchObject({ status: 504 });
	});

	it('stops an aborted paginated report before opening a database transaction', async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(getTransactionsReport(transactionInput(), ctx, controller.signal)).rejects.toMatchObject({
			status: 504,
		});
		expect(mockPrismaTransaction).not.toHaveBeenCalled();
	});

	it('does not hide a non-timeout P2028 transaction failure', async () => {
		const error = { code: 'P2028', message: 'Transaction API error: invalid transaction invocation' };
		mockPrismaTransaction.mockRejectedValue(error);

		await expect(getTransactionsReport(transactionInput(), ctx)).rejects.toBe(error);
	});

	it('converts with caller-supplied rates and never calls the rate provider', async () => {
		mockQueryReportPage.mockResolvedValue({ records: [record('seller-1')], nextCursor: null });

		const result = await getTransactionsReport(
			{
				...transactionInput(),
				fiat: { currency: 'usd', mode: 'AccountingDate', suppliedRates: [{ unit: 'lovelace', rate: '0.5' }] },
			},
			ctx,
		);

		expect(result.metadata.fiat).toMatchObject({ currency: 'usd', provider: 'supplied', completeness: 'complete' });
	});

	it('loads all pages and rejects an aggregate above its row limit', async () => {
		const nextCursor = {
			Buyer: null,
			Seller: { createdAt: new Date('2026-01-02T00:00:00.000Z'), id: 'seller-1' },
		};
		mockQueryReportPage
			.mockResolvedValueOnce({ records: [record('seller-1')], nextCursor })
			.mockResolvedValueOnce({ records: [record('seller-2')], nextCursor: null });

		await expect(
			loadAllReportRows(
				{
					paymentSourceId: 'source-1',
					paymentSourceType: PaymentSourceType.Web3CardanoV2,
					configuredFeeRatePermille: 25,
					authorizedManagedWalletIds: ['wallet-1'],
					externalAddresses: [],
					roles: ['Seller'],
					states: [],
					from: new Date('2026-01-01T00:00:00.000Z'),
					to: new Date('2026-02-01T00:00:00.000Z'),
					dateBasis: 'CreatedAt',
					revenueMode: 'Billable',
					asOf: new Date('2026-02-02T00:00:00.000Z'),
				},
				{ pageSize: 1, maxRows: 1 },
			),
		).rejects.toMatchObject({ status: 413 });
	});

	it.each([
		{
			name: 'metadata bytes',
			record: { ...record('metadata-limit'), metadata: '12345' },
			limits: { maxMetadataBytes: 4 },
		},
		{
			name: 'transaction events',
			record: {
				...record('event-limit'),
				transactions: [
					...record('event-limit').transactions,
					{ ...record('event-limit').transactions[0], id: 'second-event', txHash: 'second-hash' },
				],
			},
			limits: { maxEvents: 1 },
		},
		{
			name: 'unique asset units',
			record: {
				...record('asset-limit'),
				requestedFunds: [
					{ unit: 'policy-a', amount: 1n },
					{ unit: 'policy-b', amount: 1n },
				],
			},
			limits: { maxAssetUnits: 1 },
		},
		{
			name: 'serialized bytes',
			record: record('serialized-limit'),
			limits: { maxSerializedBytes: 1 },
		},
	])('rejects a complete report above its progressive $name budget', async ({ record: value, limits }) => {
		mockQueryReportPage.mockResolvedValue({ records: [value], nextCursor: null });

		await expect(loadAllReportRows(queryFilters(), limits)).rejects.toMatchObject({ status: 413 });
	});

	it('applies progressive metadata budgets across database pages', async () => {
		const nextCursor = {
			Buyer: null,
			Seller: { createdAt: new Date('2026-01-02T00:00:00.000Z'), id: 'metadata-page-1' },
		};
		mockQueryReportPage
			.mockResolvedValueOnce({ records: [{ ...record('metadata-page-1'), metadata: '12345' }], nextCursor })
			.mockResolvedValueOnce({ records: [{ ...record('metadata-page-2'), metadata: '67890' }], nextCursor: null });

		await expect(loadAllReportRows(queryFilters(), { pageSize: 1, maxMetadataBytes: 8 })).rejects.toMatchObject({
			status: 413,
		});
	});

	it('fails a stalled aggregate cursor instead of looping', async () => {
		const stalledCursor = {
			Buyer: null,
			Seller: { createdAt: new Date('2026-01-02T00:00:00.000Z'), id: 'seller-1' },
		};
		mockQueryReportPage.mockResolvedValue({ records: [], nextCursor: stalledCursor });

		await expect(
			loadAllReportRows(
				{
					paymentSourceId: 'source-1',
					paymentSourceType: PaymentSourceType.Web3CardanoV2,
					configuredFeeRatePermille: 25,
					authorizedManagedWalletIds: null,
					externalAddresses: [],
					roles: ['Seller'],
					states: [],
					from: new Date('2026-01-01T00:00:00.000Z'),
					to: new Date('2026-02-01T00:00:00.000Z'),
					dateBasis: 'CreatedAt',
					revenueMode: 'Billable',
					asOf: new Date('2026-02-02T00:00:00.000Z'),
				},
				{ pageSize: 1 },
			),
		).rejects.toThrow('Report pagination did not advance');
	});

	it('enforces the aggregate deadline after the final database page', async () => {
		mockQueryReportPage.mockResolvedValue({ records: [], nextCursor: null });
		const times = [0, 0, 31];

		await expect(
			loadAllReportRows(
				{
					paymentSourceId: 'source-1',
					paymentSourceType: PaymentSourceType.Web3CardanoV2,
					configuredFeeRatePermille: 25,
					authorizedManagedWalletIds: null,
					externalAddresses: [],
					roles: ['Seller'],
					states: [],
					from: new Date('2026-01-01T00:00:00.000Z'),
					to: new Date('2026-02-01T00:00:00.000Z'),
					dateBasis: 'CreatedAt',
					revenueMode: 'Billable',
					asOf: new Date('2026-02-02T00:00:00.000Z'),
				},
				{ timeoutMilliseconds: 30, now: () => times.shift() ?? 31 },
			),
		).rejects.toMatchObject({ status: 504 });
	});

	it('stops a complete report after its request is aborted between pages', async () => {
		const controller = new AbortController();
		mockQueryReportPage.mockImplementation(async () => {
			controller.abort();
			return { records: [], nextCursor: null };
		});

		await expect(loadAllReportRows(queryFilters(), {}, undefined, controller.signal)).rejects.toMatchObject({
			status: 504,
		});
	});

	it('maps archived facet records to the public reporting shape', async () => {
		mockListFacets.mockResolvedValue({
			paymentSources: [source],
			managedWallets: [
				{
					id: 'wallet-1',
					createdAt: new Date(),
					paymentSourceId: 'source-1',
					type: 'Selling',
					walletAddress: 'addr-wallet',
					walletVkey: 'wallet-vkey',
					collectionAddress: null,
					note: null,
					deletedAt: new Date('2026-01-01T00:00:00.000Z'),
				},
			],
		});

		const result = await getReportFacets(ctx);
		expect(result.managedWallets[0]).toEqual({
			id: 'wallet-1',
			paymentSourceId: 'source-1',
			type: 'Selling',
			walletAddress: 'addr-wallet',
			walletVkey: 'wallet-vkey',
			collectionAddress: null,
			note: null,
			deletedAt: new Date('2026-01-01T00:00:00.000Z'),
		});
	});

	it('loads summary pages inside one repeatable-read transaction', async () => {
		mockQueryReportPage.mockResolvedValue({ records: [], nextCursor: null });

		await getSummaryReport({ ...transactionInput(), bucket: 'Auto' }, ctx);

		expect(mockPrismaTransaction).toHaveBeenCalledWith(expect.any(Function), {
			isolationLevel: 'RepeatableRead',
			timeout: 35_000,
			maxWait: 5_000,
		});
		expect(mockQueryReportPage).toHaveBeenCalledWith(
			expect.any(Object),
			{ Buyer: null, Seller: null },
			100,
			transactionClient,
			undefined,
		);
	});

	it('returns one complete snapshot for JSON and file exports', async () => {
		mockQueryReportPage.mockResolvedValue({ records: [record('seller-export')], nextCursor: null });

		const result = await getCompleteReportData({ ...transactionInput(), bucket: 'Day' }, ctx);

		expect(result.rows).toHaveLength(1);
		expect(result.aggregate.totals.transactionCount).toBe(1);
		expect(result.metadata).toMatchObject({
			asOf: transactionAsOf,
			paymentSource: { id: 'source-1', paymentSourceType: PaymentSourceType.Web3CardanoV2 },
			filters: { paymentSourceId: 'source-1', managedWalletIds: ['wallet-1'] },
		});
		expect(mockPrismaTransaction).toHaveBeenCalledTimes(1);
	});

	it('keeps settled Billable revenue in its earlier unlock bucket', async () => {
		const unlockAt = new Date('2026-01-01T12:00:00.000Z');
		mockQueryReportPage.mockResolvedValue({
			records: [
				{
					...record('seller-accrual'),
					unlockTime: BigInt(unlockAt.getTime()),
					transactions: [
						{
							id: 'tx-result',
							txHash: 'hash-result',
							status: 'Confirmed',
							newOnChainState: 'ResultSubmitted',
							blockTime: Math.floor(new Date('2025-12-31T12:00:00.000Z').getTime() / 1000),
							fees: 0n,
						},
						{
							id: 'tx-withdraw',
							txHash: 'hash-withdraw',
							status: 'Confirmed',
							newOnChainState: 'Withdrawn',
							blockTime: Math.floor(new Date('2026-02-01T12:00:00.000Z').getTime() / 1000),
							fees: 0n,
						},
					],
				},
			],
			nextCursor: null,
		});

		const result = await getCompleteReportData(
			{
				...transactionInput(),
				from: new Date('2026-01-01T00:00:00.000Z'),
				to: new Date('2026-01-02T00:00:00.000Z'),
				dateBasis: 'RevenueRecognizedAt',
				bucket: 'Day',
			},
			ctx,
		);

		expect(result.rows[0].timestamps.sellerRevenueRecognizedAt).toEqual(unlockAt);
		expect(result.aggregate.history[0].metrics.sellerGrossRevenue.amounts).toEqual([
			{ unit: 'lovelace', amount: 9_007_199_254_740_993n },
		]);
	});

	it('keeps conflicting actor evidence partial after detail canonicalization and aggregation', async () => {
		const relatedRequestKeys = ['Seller:seller-conflict-a', 'Seller:seller-conflict-b'];
		const transaction = {
			id: 'tx-conflict',
			txHash: 'hash-conflict',
			status: 'Confirmed',
			newOnChainState: 'Withdrawn' as const,
			blockTime: 1_767_312_000,
			fees: 100n,
			relatedRequestKeys,
			relatedPaymentKeys: ['chain-conflict'],
			relatedPaymentKeysComplete: true,
		};
		mockQueryReportPage.mockResolvedValue({
			records: [
				{
					...record('seller-conflict-a'),
					blockchainIdentifier: 'chain-conflict',
					sellerCardanoFees: 20n,
					transactions: [transaction],
				},
				{
					...record('seller-conflict-b'),
					blockchainIdentifier: 'chain-conflict',
					sellerCardanoFees: 25n,
					transactions: [transaction],
				},
			],
			nextCursor: null,
		});

		const result = await getCompleteReportData({ ...transactionInput(), bucket: 'Day' }, ctx);

		expect(result.aggregate.totals.totalCardanoFees).toEqual({
			amounts: [{ unit: 'lovelace', amount: 100n }],
			completeness: 'complete',
		});
		expect(result.aggregate.totals.adminCardanoFees).toEqual({ amounts: [], completeness: 'partial' });
		expect(result.rows.filter((row) => row.isFeeReconciliationOwner)).toHaveLength(1);
		expect(result.rows.find((row) => row.isFeeReconciliationOwner)?.actorCardanoFeeAllocation.completeness).toBe(
			'partial',
		);
	});
});
