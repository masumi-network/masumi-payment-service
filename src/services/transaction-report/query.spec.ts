import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { OnChainState, PaymentSourceType } from '@/generated/prisma/client';
import type { ReportQueryFilters } from './query';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindPayments = jest.fn() as AnyMock;
const mockFindPurchases = jest.fn() as AnyMock;
const mockFindTransactions = jest.fn() as AnyMock;
const mockQueryRaw = jest.fn() as AnyMock;
const mockResolvePaymentKeyHash = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		paymentRequest: { findMany: mockFindPayments },
		purchaseRequest: { findMany: mockFindPurchases },
		transaction: { findMany: mockFindTransactions },
		$queryRaw: mockQueryRaw,
	},
}));

jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONFIG: { ENCRYPTION_KEY: 'report-cursor-test-key-with-32-characters' },
	CONSTANTS: { MIN_COLLATERAL_LOVELACE: 1_435_230n },
}));

jest.unstable_mockModule('@meshsdk/core-cst', () => ({
	resolvePaymentKeyHash: mockResolvePaymentKeyHash,
}));

const {
	createReportCursorSnapshot,
	createReportFilterFingerprint,
	decodeReportCursor,
	encodeReportCursor,
	queryReportFeeComponentClosure,
	queryReportPage,
} = await import('./query');
const { buildReportRow } = await import('./records');

function filters(overrides: Partial<ReportQueryFilters> = {}): ReportQueryFilters {
	return {
		paymentSourceId: 'source-1',
		paymentSourceType: PaymentSourceType.Web3CardanoV2,
		configuredFeeRatePermille: 0,
		authorizedManagedWalletIds: ['wallet-1'],
		externalAddresses: [],
		roles: ['Buyer', 'Seller'],
		states: [],
		from: new Date('2026-01-01T00:00:00.000Z'),
		to: new Date('2026-02-01T00:00:00.000Z'),
		dateBasis: 'CreatedAt',
		revenueMode: 'Billable',
		asOf: new Date('2026-02-02T00:00:00.000Z'),
		...overrides,
	};
}

type TransactionRelations = {
	paymentCurrentIds?: string[];
	paymentHistoryIds?: string[];
	purchaseCurrentIds?: string[];
	purchaseHistoryIds?: string[];
	blockchainIdentifiers?: Record<string, string>;
};

function transaction(
	newOnChainState: OnChainState = OnChainState.FundsLocked,
	relations: TransactionRelations = { paymentCurrentIds: ['payment-1'] },
) {
	const relatedRequest = (id: string) => ({
		id,
		blockchainIdentifier: relations.blockchainIdentifiers?.[id] ?? `chain-${id}`,
	});
	return {
		id: `tx-${newOnChainState}`,
		txHash: `hash-${newOnChainState}`,
		status: 'Confirmed',
		newOnChainState,
		blockTime: 1_767_225_700,
		fees: 200_000n,
		PaymentRequestCurrent: (relations.paymentCurrentIds ?? []).map(relatedRequest),
		PaymentRequestHistory: (relations.paymentHistoryIds ?? []).map(relatedRequest),
		PurchaseRequestCurrent: (relations.purchaseCurrentIds ?? []).map(relatedRequest),
		PurchaseRequestHistory: (relations.purchaseHistoryIds ?? []).map(relatedRequest),
	};
}

function mockIndexedTransactions(transactions: ReturnType<typeof transaction>[]): void {
	mockFindTransactions.mockImplementation(({ where }: { where: Record<string, { in: string[] }> }) => {
		const txHashes = where.txHash?.in;
		if (txHashes != null)
			return transactions.filter((value) => value.txHash != null && txHashes.includes(value.txHash));
		const transactionIds = where.id?.in;
		return transactionIds == null ? [] : transactions.filter((value) => transactionIds.includes(value.id));
	});
}

function paymentRecord(id: string, createdAt: string) {
	return {
		id,
		createdAt: new Date(createdAt),
		blockchainIdentifier: `chain-${id}`,
		agentIdentifier: null,
		agentName: null,
		onChainState: OnChainState.FundsLocked,
		metadata: null,
		unlockTime: 1_800_000_000_000n,
		collateralReturnLovelace: 0n,
		buyerReturnAddress: null,
		sellerReturnAddress: null,
		totalBuyerCardanoFees: 100_000n,
		totalSellerCardanoFees: 0n,
		BuyerWallet: { walletAddress: 'addr-buyer', walletVkey: 'buyer-vkey' },
		SmartContractWallet: {
			id: 'wallet-1',
			walletAddress: 'addr-seller',
			walletVkey: 'seller-vkey',
			collectionAddress: 'addr-collection',
			deletedAt: null,
		},
		RequestedFunds: [{ unit: 'lovelace', amount: 10_000_000n }],
		WithdrawnForBuyer: [],
		WithdrawnForSeller: [],
		CurrentTransaction: transaction(OnChainState.FundsLocked, { paymentCurrentIds: [id] }),
		TransactionHistory: [],
	};
}

function purchaseRecord(id: string, createdAt: string) {
	return {
		id,
		createdAt: new Date(createdAt),
		blockchainIdentifier: `chain-${id}`,
		agentIdentifier: null,
		agentName: null,
		onChainState: OnChainState.FundsLocked,
		metadata: null,
		unlockTime: 1_800_000_000_000n,
		collateralReturnLovelace: 0n,
		buyerReturnAddress: null,
		sellerReturnAddress: null,
		totalBuyerCardanoFees: 100_000n,
		totalSellerCardanoFees: 0n,
		SellerWallet: { walletAddress: 'addr-seller', walletVkey: 'seller-vkey' },
		SmartContractWallet: {
			id: 'wallet-1',
			walletAddress: 'addr-buyer',
			walletVkey: 'buyer-vkey',
			collectionAddress: 'addr-collection',
			deletedAt: null,
		},
		PaidFunds: [{ unit: 'lovelace', amount: 10_000_000n }],
		WithdrawnForBuyer: [],
		WithdrawnForSeller: [],
		CurrentTransaction: transaction(OnChainState.FundsLocked, { purchaseCurrentIds: [id] }),
		TransactionHistory: [],
	};
}

beforeEach(() => {
	jest.clearAllMocks();
	mockFindPayments.mockResolvedValue([]);
	mockFindPurchases.mockResolvedValue([]);
	mockFindTransactions.mockResolvedValue([]);
	mockQueryRaw.mockImplementation(async (query: { values?: unknown[] }) =>
		(query.values ?? [])
			.filter((value): value is string => typeof value === 'string')
			.map((id) => ({ id, metadata: null, isOversized: false })),
	);
	mockResolvePaymentKeyHash.mockReturnValue('same-vkey');
});

describe('report cursor', () => {
	it('round trips signed role positions and snapshot semantics', () => {
		const positions = {
			Buyer: { createdAt: new Date('2026-01-02T00:00:00.000Z'), id: 'buyer-1' },
			Seller: { createdAt: new Date('2026-01-03T00:00:00.000Z'), id: 'seller-1' },
		};
		const input = filters();
		const filterFingerprint = createReportFilterFingerprint({ ...input, timeZone: 'Europe/Prague' });
		const snapshot = createReportCursorSnapshot(input, filterFingerprint);
		expect(decodeReportCursor(encodeReportCursor({ positions, snapshot }))).toEqual({ positions, snapshot });
	});

	it('returns empty internal positions and no snapshot when a cursor is absent', () => {
		expect(decodeReportCursor(undefined)).toEqual({
			positions: { Buyer: null, Seller: null },
			snapshot: null,
		});
	});

	it('makes filter fingerprints independent of set-like filter order', () => {
		const input = filters({
			authorizedManagedWalletIds: ['wallet-2', 'wallet-1'],
			externalAddresses: ['addr-2', 'addr-1'],
			roles: ['Seller', 'Buyer'],
			states: [OnChainState.Withdrawn, OnChainState.FundsLocked],
		});
		const first = createReportFilterFingerprint({ ...input, timeZone: 'Europe/Prague' });
		const second = createReportFilterFingerprint({
			...input,
			authorizedManagedWalletIds: ['wallet-1', 'wallet-2', 'wallet-1'],
			externalAddresses: ['addr-1', 'addr-2'],
			roles: ['Buyer', 'Seller'],
			states: [OnChainState.FundsLocked, OnChainState.Withdrawn],
			timeZone: 'Europe/Prague',
		});
		expect(first).toBe(second);
	});

	it('changes the fingerprint for every bound report filter', () => {
		const input = filters();
		const base = createReportFilterFingerprint({ ...input, timeZone: 'Etc/UTC' });
		const variations = [
			{ ...input, paymentSourceId: 'source-2', timeZone: 'Etc/UTC' },
			{ ...input, authorizedManagedWalletIds: ['wallet-2'], timeZone: 'Etc/UTC' },
			{ ...input, externalAddresses: ['addr-external'], timeZone: 'Etc/UTC' },
			{ ...input, roles: ['Seller'] as ReportQueryFilters['roles'], timeZone: 'Etc/UTC' },
			{ ...input, states: [OnChainState.Withdrawn], timeZone: 'Etc/UTC' },
			{ ...input, from: new Date('2026-01-02T00:00:00.000Z'), timeZone: 'Etc/UTC' },
			{ ...input, to: new Date('2026-01-31T00:00:00.000Z'), timeZone: 'Etc/UTC' },
			{ ...input, dateBasis: 'FundsLockedAt' as const, timeZone: 'Etc/UTC' },
			{ ...input, revenueMode: 'CashReceived' as const, timeZone: 'Etc/UTC' },
			{ ...input, timeZone: 'Europe/Prague' },
		];

		for (const variation of variations) {
			expect(createReportFilterFingerprint(variation)).not.toBe(base);
		}
	});

	it('rejects malformed cursors', () => {
		expect(() => decodeReportCursor('not-json')).toThrow('Invalid report cursor');
	});

	it('rejects a cursor whose signed payload was changed', () => {
		const input = filters();
		const positions = { Buyer: null, Seller: null };
		const snapshot = createReportCursorSnapshot(
			input,
			createReportFilterFingerprint({ ...input, timeZone: 'Etc/UTC' }),
		);
		const encoded = encodeReportCursor({ positions, snapshot });
		const [payload, signature] = encoded.split('.');
		const replacement = payload[0] === 'A' ? 'B' : 'A';
		const tampered = `${replacement}${payload.slice(1)}.${signature}`;
		expect(() => decodeReportCursor(tampered)).toThrow('Invalid report cursor');
	});
});

describe('queryReportPage', () => {
	it('keeps Payment Source ID, wallet scope, and external address as cumulative filters', async () => {
		await queryReportPage(
			filters({ externalAddresses: ['addr-external'], states: [OnChainState.Withdrawn] }),
			{ Buyer: null, Seller: null },
			50,
		);

		expect(mockFindPayments).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					paymentSourceId: 'source-1',
					smartContractWalletId: { in: ['wallet-1'] },
					onChainState: { in: [OnChainState.Withdrawn] },
					AND: expect.arrayContaining([
						expect.objectContaining({ createdAt: expect.any(Object) }),
						expect.objectContaining({ OR: expect.any(Array) }),
					]),
				}),
			}),
		);
		const paymentWhere = mockFindPayments.mock.calls[0][0].where;
		expect(paymentWhere.PaymentSource).toBeUndefined();
		expect(paymentWhere.deletedAt).toBeUndefined();
		expect(paymentWhere.AND[1]).toEqual(
			expect.objectContaining({
				OR: expect.arrayContaining([
					{ SmartContractWallet: { is: { collectionAddress: { in: ['addr-external'] } } } },
					{ SmartContractWallet: { is: { walletAddress: { in: ['addr-external'] } } } },
				]),
			}),
		);
		expect(paymentWhere.AND[2]).toEqual({
			createdAt: { lte: new Date('2026-02-02T00:00:00.000Z') },
			nextActionOrOnChainStateOrResultLastChangedAt: { lte: new Date('2026-02-02T00:00:00.000Z') },
		});
		const purchaseWhere = mockFindPurchases.mock.calls[0][0].where;
		expect(purchaseWhere.AND[1]).toEqual(
			expect.objectContaining({
				OR: expect.arrayContaining([
					{ SmartContractWallet: { is: { collectionAddress: { in: ['addr-external'] } } } },
					{ SmartContractWallet: { is: { walletAddress: { in: ['addr-external'] } } } },
				]),
			}),
		);
	});

	it('maps the Pending state filter to null on-chain state', async () => {
		await queryReportPage(filters({ states: ['Pending'] }), { Buyer: null, Seller: null }, 50);

		expect(mockFindPayments.mock.calls[0][0].where.onChainState).toBeNull();
		expect(mockFindPurchases.mock.calls[0][0].where.onChainState).toBeNull();
	});

	it('uses confirmed FundsLocked chain time for that date basis', async () => {
		await queryReportPage(
			filters({ dateBasis: 'FundsLockedAt', roles: ['Seller'] }),
			{ Buyer: null, Seller: null },
			50,
		);
		const paymentWhere = mockFindPayments.mock.calls[0][0].where;
		expect(paymentWhere.AND[0]).toEqual(
			expect.objectContaining({
				OR: expect.arrayContaining([
					expect.objectContaining({
						OR: expect.arrayContaining([
							expect.objectContaining({
								CurrentTransaction: {
									is: expect.objectContaining({
										status: 'Confirmed',
										newOnChainState: OnChainState.FundsLocked,
									}),
								},
							}),
						]),
					}),
					expect.objectContaining({ AND: expect.any(Array) }),
				]),
			}),
		);
	});

	it('includes confirmed fee-only events in revenue-recognized queries', async () => {
		await queryReportPage(
			filters({ dateBasis: 'RevenueRecognizedAt', revenueMode: 'CashReceived' }),
			{ Buyer: null, Seller: null },
			50,
		);
		const feeEvent = expect.objectContaining({
			OR: expect.arrayContaining([
				expect.objectContaining({
					OR: expect.arrayContaining([
						expect.objectContaining({
							CurrentTransaction: {
								is: expect.objectContaining({ status: 'Confirmed', blockTime: expect.any(Object) }),
							},
						}),
					]),
				}),
				expect.objectContaining({ OR: expect.any(Array) }),
			]),
		});
		expect(mockFindPayments.mock.calls[0][0].where.AND[0].OR).toEqual(expect.arrayContaining([feeEvent]));
		expect(mockFindPurchases.mock.calls[0][0].where.AND[0].OR).toEqual(expect.arrayContaining([feeEvent]));
	});

	it('includes unlocked Withdrawn rows in Billable revenue-recognized queries', async () => {
		await queryReportPage(
			filters({ dateBasis: 'RevenueRecognizedAt', revenueMode: 'Billable', roles: ['Seller'] }),
			{ Buyer: null, Seller: null },
			50,
		);

		expect(mockFindPayments.mock.calls[0][0].where.AND[0].OR).toEqual(
			expect.arrayContaining([
				{
					onChainState: { in: [OnChainState.ResultSubmitted, OnChainState.Withdrawn] },
					unlockTime: {
						gte: BigInt(new Date('2026-01-01T00:00:00.000Z').getTime()),
						lt: BigInt(new Date('2026-02-01T00:00:00.000Z').getTime()),
						lte: BigInt(new Date('2026-02-02T00:00:00.000Z').getTime()),
					},
				},
			]),
		);
	});

	it('merges buyer and seller rows with stable exclusive role cursors', async () => {
		mockFindPayments.mockResolvedValue([
			paymentRecord('seller-new', '2026-01-03T00:00:00.000Z'),
			paymentRecord('seller-old', '2026-01-01T00:00:00.000Z'),
		]);
		mockFindPurchases.mockResolvedValue([purchaseRecord('buyer-middle', '2026-01-02T00:00:00.000Z')]);

		const result = await queryReportPage(filters(), { Buyer: null, Seller: null }, 2);
		expect(result.records.map((record) => record.id)).toEqual(['seller-new', 'buyer-middle']);
		expect(result.nextCursor).toEqual({
			Seller: { createdAt: new Date('2026-01-03T00:00:00.000Z'), id: 'seller-new' },
			Buyer: { createdAt: new Date('2026-01-02T00:00:00.000Z'), id: 'buyer-middle' },
		});
	});

	it('marks a disputed V2 payout partial when its return payment key differs', async () => {
		mockResolvePaymentKeyHash.mockReturnValue('different-vkey');
		mockFindPayments.mockResolvedValue([
			{
				...paymentRecord('seller-disputed', '2026-01-03T00:00:00.000Z'),
				onChainState: OnChainState.DisputedWithdrawn,
				sellerReturnAddress: 'addr-return',
			},
		]);

		const result = await queryReportPage(filters({ roles: ['Seller'] }), { Buyer: null, Seller: null }, 50);
		expect(result.records[0].sellerPayoutCompleteness).toBe('partial');
	});

	it.each([
		['Seller', 'sellerPayoutCompleteness'],
		['Buyer', 'buyerPayoutCompleteness'],
	] as const)('marks a disputed V2 %s payout partial when its return address is missing', async (role, field) => {
		if (role === 'Seller') {
			mockFindPayments.mockResolvedValue([
				{
					...paymentRecord('seller-missing-return', '2026-01-03T00:00:00.000Z'),
					onChainState: OnChainState.DisputedWithdrawn,
					sellerReturnAddress: null,
				},
			]);
		} else {
			mockFindPurchases.mockResolvedValue([
				{
					...purchaseRecord('buyer-missing-return', '2026-01-03T00:00:00.000Z'),
					onChainState: OnChainState.DisputedWithdrawn,
					buyerReturnAddress: null,
				},
			]);
		}

		const result = await queryReportPage(filters({ roles: [role] }), { Buyer: null, Seller: null }, 50);

		expect(result.records[0][field]).toBe('partial');
	});

	it.each([PaymentSourceType.Web3CardanoV1, PaymentSourceType.Web3CardanoV2])(
		'marks a disputed %s buyer payout partial when collateral cannot be separated',
		async (paymentSourceType) => {
			mockResolvePaymentKeyHash.mockReturnValue('buyer-vkey');
			mockFindPurchases.mockResolvedValue([
				{
					...purchaseRecord('buyer-collateral', '2026-01-03T00:00:00.000Z'),
					onChainState: OnChainState.DisputedWithdrawn,
					buyerReturnAddress: 'addr-return',
					collateralReturnLovelace: 2_000_000n,
				},
			]);

			const result = await queryReportPage(
				filters({ paymentSourceType, roles: ['Buyer'] }),
				{ Buyer: null, Seller: null },
				50,
			);

			expect(result.records[0].buyerPayoutCompleteness).toBe('partial');
		},
	);

	it('uses stored payout rows as V1 disputed payout provenance', async () => {
		mockFindPayments
			.mockResolvedValueOnce([
				{
					...paymentRecord('seller-legacy-empty', '2026-01-03T00:00:00.000Z'),
					onChainState: OnChainState.DisputedWithdrawn,
				},
			])
			.mockResolvedValueOnce([
				{
					...paymentRecord('seller-modern-payout', '2026-01-03T00:00:00.000Z'),
					onChainState: OnChainState.DisputedWithdrawn,
					WithdrawnForSeller: [{ unit: 'lovelace', amount: 5_000_000n }],
				},
			]);
		const input = filters({ paymentSourceType: PaymentSourceType.Web3CardanoV1, roles: ['Seller'] });

		const empty = await queryReportPage(input, { Buyer: null, Seller: null }, 50);
		const nonempty = await queryReportPage(input, { Buyer: null, Seller: null }, 50);

		expect(empty.records[0].sellerPayoutCompleteness).toBe('partial');
		expect(nonempty.records[0].sellerPayoutCompleteness).toBe('complete');
	});

	it('keeps collection address in the canonical managed wallet output', async () => {
		mockFindPayments.mockResolvedValue([paymentRecord('seller-1', '2026-01-03T00:00:00.000Z')]);

		const result = await queryReportPage(
			filters({ paymentSourceType: PaymentSourceType.Web3CardanoV1, roles: ['Seller'] }),
			{ Buyer: null, Seller: null },
			50,
		);
		expect(result.records[0].managedWallet).toEqual(expect.objectContaining({ collectionAddress: 'addr-collection' }));
	});

	it.each([
		{
			name: 'transaction history',
			override: {
				TransactionHistory: Array.from({ length: 101 }, (_value, index) => ({
					...transaction(),
					id: `history-${index}`,
					txHash: `history-hash-${index}`,
				})),
			},
		},
		{
			name: 'asset relations',
			override: {
				RequestedFunds: Array.from({ length: 1_001 }, (_value, index) => ({
					unit: `policy-${index}`,
					amount: 1n,
				})),
			},
		},
	])('rejects an oversized nested $name relation', async ({ override }) => {
		mockFindPayments.mockResolvedValue([
			{ ...paymentRecord('bounded-relations', '2026-01-03T00:00:00.000Z'), ...override },
		]);

		await expect(
			queryReportPage(filters({ roles: ['Seller'] }), { Buyer: null, Seller: null }, 50),
		).rejects.toMatchObject({ status: 413 });
	});

	it('rejects oversized inverse request relations in bounded same-hash evidence', async () => {
		const record = paymentRecord('bounded-related-requests', '2026-01-03T00:00:00.000Z');
		mockFindPayments.mockResolvedValue([record]);
		mockFindTransactions.mockResolvedValue([
			transaction(OnChainState.FundsLocked, {
				paymentHistoryIds: Array.from({ length: 101 }, (_value, index) => `related-${index}`),
			}),
		]);

		await expect(
			queryReportPage(filters({ roles: ['Seller'] }), { Buyer: null, Seller: null }, 50),
		).rejects.toMatchObject({ status: 413 });
	});

	it('hydrates bounded metadata without selecting unbounded text in the main query', async () => {
		const record = paymentRecord('bounded-metadata', '2026-01-03T00:00:00.000Z');
		mockFindPayments.mockResolvedValue([record]);
		mockQueryRaw.mockResolvedValue([{ id: record.id, metadata: '{"safe":true}', isOversized: false }]);

		const result = await queryReportPage(filters({ roles: ['Seller'] }), { Buyer: null, Seller: null }, 50);

		expect(mockFindPayments.mock.calls[0][0].select.metadata).toBeUndefined();
		expect(result.records[0].metadata).toBe('{"safe":true}');
		const rawQuery = mockQueryRaw.mock.calls[0][0] as { sql: string };
		expect(rawQuery.sql).toContain('CASE');
		expect(rawQuery.sql).toContain('octet_length');
	});

	it('rejects oversized metadata before the database returns its text', async () => {
		const record = paymentRecord('oversized-metadata', '2026-01-03T00:00:00.000Z');
		mockFindPayments.mockResolvedValue([record]);
		mockQueryRaw.mockResolvedValue([{ id: record.id, metadata: null, isOversized: true }]);

		await expect(
			queryReportPage(filters({ roles: ['Seller'] }), { Buyer: null, Seller: null }, 50),
		).rejects.toMatchObject({ status: 413 });
		expect(mockFindPayments.mock.calls[0][0].select.metadata).toBeUndefined();
	});

	it('rejects an oversized same-hash evidence query', async () => {
		mockFindPayments.mockResolvedValue([paymentRecord('bounded-evidence', '2026-01-03T00:00:00.000Z')]);
		mockFindTransactions.mockResolvedValue(
			Array.from({ length: 5_001 }, (_value, index) => ({
				...transaction(),
				id: `evidence-${index}`,
			})),
		);

		await expect(
			queryReportPage(filters({ roles: ['Seller'] }), { Buyer: null, Seller: null }, 50),
		).rejects.toMatchObject({ status: 413 });
	});

	it('marks a real multi-request transaction as shared and exposes stable coverage keys', async () => {
		const sharedTransaction = transaction(OnChainState.FundsLocked, {
			purchaseCurrentIds: ['buyer-batch', 'buyer-sibling'],
		});
		mockFindPurchases.mockResolvedValue([
			{
				...purchaseRecord('buyer-batch', '2026-01-03T00:00:00.000Z'),
				CurrentTransaction: sharedTransaction,
			},
		]);
		mockFindTransactions.mockResolvedValue([sharedTransaction]);

		const result = await queryReportPage(
			filters({ paymentSourceType: PaymentSourceType.Web3CardanoV1, roles: ['Buyer'] }),
			{ Buyer: null, Seller: null },
			50,
		);
		expect(result.records[0].feeAllocationScope).toBe('shared_or_unknown');
		expect(result.records[0].transactions[0].relatedRequestKeys).toEqual(['Buyer:buyer-batch', 'Buyer:buyer-sibling']);
		expect(result.records[0].transactions[0].relatedPaymentKeys).toEqual(['chain-buyer-batch', 'chain-buyer-sibling']);
	});

	it('merges repeated attached transactions but keeps missing indexed evidence partial', async () => {
		const currentTransaction = transaction(OnChainState.FundsLocked, {
			paymentCurrentIds: ['seller-repeated'],
		});
		const historicalTransaction = transaction(OnChainState.FundsLocked, {
			paymentHistoryIds: ['seller-repeated'],
		});
		mockFindPayments.mockResolvedValue([
			{
				...paymentRecord('seller-repeated', '2026-01-03T00:00:00.000Z'),
				CurrentTransaction: currentTransaction,
				TransactionHistory: [historicalTransaction],
			},
		]);

		const result = await queryReportPage(
			filters({ paymentSourceType: PaymentSourceType.Web3CardanoV1, roles: ['Seller'] }),
			{ Buyer: null, Seller: null },
			50,
		);
		expect(result.records[0].feeAllocationScope).toBe('shared_or_unknown');
		expect(result.records[0].feeComponentScope).toBe('partial');
		expect(result.records[0].isFeeReconciliationOwner).toBe(true);
		expect(result.records[0].transactions).toHaveLength(1);
		expect(result.records[0].transactions[0].relatedRequestKeys).toBeNull();
		expect(result.records[0].transactions[0].relatedPaymentKeys).toBeNull();
	});

	it('keeps paired mirror evidence partial without indexed batch membership', async () => {
		const pairedTransaction = transaction(OnChainState.FundsLocked, {
			paymentCurrentIds: ['seller-paired'],
			purchaseCurrentIds: ['buyer-paired'],
			blockchainIdentifiers: {
				'seller-paired': 'chain-paired',
				'buyer-paired': 'chain-paired',
			},
		});
		mockFindPayments.mockResolvedValue([
			{
				...paymentRecord('seller-paired', '2026-01-03T00:00:00.000Z'),
				blockchainIdentifier: 'chain-paired',
				CurrentTransaction: pairedTransaction,
			},
		]);

		const result = await queryReportPage(
			filters({ paymentSourceType: PaymentSourceType.Web3CardanoV1, roles: ['Seller'] }),
			{ Buyer: null, Seller: null },
			50,
		);
		expect(result.records[0].feeAllocationScope).toBe('shared_or_unknown');
		expect(result.records[0].feeComponentScope).toBe('partial');
		expect(result.records[0].isFeeReconciliationOwner).toBe(true);
		expect(result.records[0].transactions[0].relatedRequestKeys).toBeNull();
		expect(result.records[0].transactions[0].relatedPaymentKeys).toBeNull();
	});

	it('assigns paired payment ownership to Buyer when both roles are requested', async () => {
		const pairedTransaction = transaction(OnChainState.FundsLocked, {
			paymentCurrentIds: ['seller-paired'],
			purchaseCurrentIds: ['buyer-paired'],
			blockchainIdentifiers: {
				'seller-paired': 'chain-paired',
				'buyer-paired': 'chain-paired',
			},
		});
		mockFindPayments.mockResolvedValue([
			{
				...paymentRecord('seller-paired', '2026-01-03T00:00:00.000Z'),
				blockchainIdentifier: 'chain-paired',
				CurrentTransaction: pairedTransaction,
			},
		]);
		mockFindPurchases.mockResolvedValue([
			{
				...purchaseRecord('buyer-paired', '2026-01-03T00:00:00.000Z'),
				blockchainIdentifier: 'chain-paired',
				CurrentTransaction: pairedTransaction,
			},
		]);

		const result = await queryReportPage(
			filters({ paymentSourceType: PaymentSourceType.Web3CardanoV1 }),
			{ Buyer: null, Seller: null },
			50,
		);
		const buyer = result.records.find((record) => record.role === 'Buyer');
		const seller = result.records.find((record) => record.role === 'Seller');
		expect(buyer).toMatchObject({
			isFeeReconciliationOwner: true,
			feeComponentScope: 'partial',
			feeAllocationScope: 'shared_or_unknown',
		});
		expect(seller).toMatchObject({
			isFeeReconciliationOwner: false,
			feeComponentScope: 'partial',
			feeAllocationScope: 'shared_or_unknown',
		});
	});

	it('marks a selected mirror partial after indexed same-hash evidence finds a filtered sibling', async () => {
		const selected = paymentRecord('v2-mirror', '2026-01-03T00:00:00.000Z');
		const sibling = transaction(OnChainState.FundsLocked, { paymentCurrentIds: ['v2-sibling'] });
		sibling.txHash = selected.CurrentTransaction.txHash;
		mockFindPayments.mockResolvedValue([selected]);
		mockFindTransactions.mockResolvedValue([selected.CurrentTransaction, sibling]);

		const result = await queryReportPage(filters({ roles: ['Seller'] }), { Buyer: null, Seller: null }, 50);

		expect(mockFindTransactions).toHaveBeenCalledWith(
			expect.objectContaining({ where: { txHash: { in: [selected.CurrentTransaction.txHash] } } }),
		);
		expect(result.records[0].transactions[0].relatedPaymentKeys).toEqual(['chain-v2-mirror', 'chain-v2-sibling']);
		expect(result.records[0]).toMatchObject({
			feeAllocationScope: 'shared_or_unknown',
			feeComponentScope: 'partial',
		});
		// The batch is known, so the fee can be shared. It is still a batch, so
		// this request cannot claim the whole of it.
		expect(result.records[0].transactions[0].relatedPaymentKeysComplete).toBe(true);
	});

	it('preserves request-specific states when indexed mirrors share one transaction hash', async () => {
		const selected = {
			...paymentRecord('v2-result', '2026-01-03T00:00:00.000Z'),
			onChainState: OnChainState.ResultSubmitted,
			CurrentTransaction: transaction(OnChainState.ResultSubmitted, {
				paymentCurrentIds: ['v2-result'],
			}),
		};
		const sibling = transaction(OnChainState.Disputed, { paymentCurrentIds: ['v2-disputed'] });
		sibling.txHash = selected.CurrentTransaction.txHash;
		mockFindPayments.mockResolvedValue([selected]);
		mockIndexedTransactions([selected.CurrentTransaction, sibling]);

		const result = await queryReportPage(filters({ roles: ['Seller'] }), { Buyer: null, Seller: null }, 50);

		expect(result.records[0].transactions[0]).toMatchObject({
			newOnChainState: OnChainState.ResultSubmitted,
			relatedPaymentKeys: ['chain-v2-disputed', 'chain-v2-result'],
			relatedPaymentKeysComplete: true,
		});
	});

	it('keeps a shared transaction row state unknown across distinct payments', async () => {
		const sharedTransaction = transaction(OnChainState.ResultSubmitted, {
			paymentCurrentIds: ['v2-result', 'v2-disputed'],
		});
		const selected = {
			...paymentRecord('v2-result', '2026-01-03T00:00:00.000Z'),
			onChainState: OnChainState.ResultSubmitted,
			CurrentTransaction: sharedTransaction,
		};
		mockFindPayments.mockResolvedValue([selected]);
		mockIndexedTransactions([sharedTransaction]);

		const result = await queryReportPage(filters({ roles: ['Seller'] }), { Buyer: null, Seller: null }, 50);

		// The state stays unknown because one transaction row is linked to two
		// payments, so which payment reached that state cannot be told. Knowing
		// the batch is a separate matter, and the fee can still be shared.
		expect(result.records[0].transactions[0]).toMatchObject({
			newOnChainState: null,
			relatedPaymentKeys: ['chain-v2-disputed', 'chain-v2-result'],
			relatedPaymentKeysComplete: true,
		});
	});

	it('merges same-hash database mirrors once before attaching evidence to each row', async () => {
		const records = Array.from({ length: 100 }, (_value, index) => {
			const value = paymentRecord(`mirror-${index}`, '2026-01-03T00:00:00.000Z');
			value.CurrentTransaction.id = `mirror-tx-${index}`;
			value.CurrentTransaction.txHash = 'shared-mirror-hash';
			return value;
		});
		mockFindPayments.mockResolvedValue(records);
		mockIndexedTransactions(
			records.map((record) => ({
				...record.CurrentTransaction,
				PaymentRequestCurrent: [{ id: record.id, blockchainIdentifier: record.blockchainIdentifier }],
			})),
		);

		const result = await queryReportPage(filters({ roles: ['Seller'] }), { Buyer: null, Seller: null }, 100);

		expect(result.records).toHaveLength(100);
		expect(result.records.every((record) => record.transactions.length === 1)).toBe(true);
		expect(result.records.every((record) => record.transactions[0].relatedPaymentKeys?.length === 100)).toBe(true);
	});

	it('bounds relation hydration batches and cumulative related request rows', async () => {
		const selected = paymentRecord('bounded-hydration', '2026-01-03T00:00:00.000Z');
		const relatedIds = Array.from({ length: 100 }, (_value, index) => `related-${index}`);
		const mirrors = Array.from({ length: 251 }, (_value, index) => ({
			...transaction(OnChainState.FundsLocked, {
				paymentCurrentIds: relatedIds,
				paymentHistoryIds: relatedIds,
				purchaseCurrentIds: relatedIds,
				purchaseHistoryIds: relatedIds,
			}),
			id: `bounded-hydration-${index}`,
			txHash: selected.CurrentTransaction.txHash,
		}));
		mockFindPayments.mockResolvedValue([selected]);
		mockIndexedTransactions(mirrors);

		await expect(
			queryReportPage(filters({ roles: ['Seller'] }), { Buyer: null, Seller: null }, 50),
		).rejects.toMatchObject({
			status: 413,
			message: expect.stringContaining('100000 related request rows'),
		});
		const [scalarCall, ...hydrationCalls] = mockFindTransactions.mock.calls.map(([input]) => input);
		expect(scalarCall.select.PaymentRequestCurrent).toBeUndefined();
		expect(hydrationCalls).toHaveLength(6);
		expect(hydrationCalls.every((call) => call.where.id.in.length <= 50)).toBe(true);
	});

	it('gives a request the exact fee of a transaction that settled only that request', async () => {
		mockFindPayments.mockResolvedValue([paymentRecord('v2-mirror', '2026-01-03T00:00:00.000Z')]);
		mockIndexedTransactions([
			{
				...paymentRecord('v2-mirror', '2026-01-03T00:00:00.000Z').CurrentTransaction,
			},
		]);

		const result = await queryReportPage(filters({ roles: ['Seller'] }), { Buyer: null, Seller: null }, 50);

		expect(result.records[0]).toMatchObject({
			feeAllocationScope: 'single_request',
			feeComponentScope: 'complete',
		});
		expect(result.records[0].transactions[0].relatedPaymentKeysComplete).toBe(true);
		const row = buildReportRow(result.records[0], 'Billable', filters().asOf, {
			dateBasis: 'CreatedAt',
			from: filters().from,
			to: filters().to,
		});
		// The fee is now a figure rather than nothing. It stays partial for a
		// separate reason: the actor fee counters are cumulative, so the admin
		// share of the fee still cannot be told apart.
		expect(row.cardanoFeeReconciliation).toMatchObject({
			totalCardanoFees: 200_000n,
			completeness: 'partial',
		});
	});

	it('keeps an indexed zero-fee transaction exact without batch membership attestation', async () => {
		const selected = paymentRecord('zero-fee', '2026-01-03T00:00:00.000Z');
		selected.CurrentTransaction.fees = 0n;
		mockFindPayments.mockResolvedValue([selected]);
		mockIndexedTransactions([selected.CurrentTransaction]);

		const result = await queryReportPage(filters({ roles: ['Seller'] }), { Buyer: null, Seller: null }, 50);

		expect(result.records[0]).toMatchObject({
			feeAllocationScope: 'single_request',
			feeComponentScope: 'complete',
		});
		expect(result.records[0].transactions[0].relatedPaymentKeysComplete).toBe(true);
	});

	it('finds an in-scope Buyer counterpart outside the current Buyer page', async () => {
		mockFindPayments.mockResolvedValue([
			{
				...paymentRecord('seller-cross-page', '2026-01-03T00:00:00.000Z'),
				blockchainIdentifier: 'chain-cross-page',
			},
		]);
		mockFindPurchases.mockResolvedValueOnce([]).mockResolvedValueOnce([{ blockchainIdentifier: 'chain-cross-page' }]);

		const result = await queryReportPage(
			filters(),
			{
				Buyer: { createdAt: new Date('2026-01-02T00:00:00.000Z'), id: 'buyer-page-cursor' },
				Seller: null,
			},
			50,
		);

		expect(result.records[0]).toMatchObject({ role: 'Seller', isFeeReconciliationOwner: false });
		expect(mockFindPurchases).toHaveBeenCalledTimes(2);
		const pageWhere = mockFindPurchases.mock.calls[0][0].where;
		const ownershipWhere = mockFindPurchases.mock.calls[1][0].where;
		// The cursor sits inside AND. A second top-level OR would replace the one
		// the state filter puts there.
		expect(pageWhere.OR).toBeUndefined();
		const pageCursorClause = pageWhere.AND[pageWhere.AND.length - 1];
		expect(pageCursorClause.OR).toBeDefined();
		// The ownership lookup must not be cursor-limited, or a counterpart on an
		// earlier page stays invisible.
		expect(ownershipWhere.AND[ownershipWhere.AND.length - 1]).toEqual({});
		expect(ownershipWhere.AND.slice(0, -1)).toEqual(pageWhere.AND.slice(0, -1));
		expect(ownershipWhere.blockchainIdentifier).toEqual({ in: ['chain-cross-page'] });
	});

	it('keeps a mixed state filter on every page, not just the first', async () => {
		mockFindPayments.mockResolvedValue([]);

		await queryReportPage(
			filters({ roles: ['Seller'], states: ['Pending', OnChainState.Withdrawn] }),
			{ Buyer: null, Seller: { createdAt: new Date('2026-01-02T00:00:00.000Z'), id: 'seller-page-cursor' } },
			50,
		);

		const where = mockFindPayments.mock.calls[0][0].where;
		// The state filter owns the one top-level OR.
		expect(where.OR).toEqual([{ onChainState: { in: [OnChainState.Withdrawn] } }, { onChainState: null }]);
		// The cursor is still applied, from inside AND.
		expect(where.AND[where.AND.length - 1].OR).toBeDefined();
	});

	it('keeps fee ownership on a Seller when no Buyer row exists', async () => {
		mockFindPayments.mockResolvedValue([paymentRecord('seller-only', '2026-01-03T00:00:00.000Z')]);

		const result = await queryReportPage(filters(), { Buyer: null, Seller: null }, 50);

		expect(result.records).toHaveLength(1);
		expect(result.records[0]).toMatchObject({ role: 'Seller', isFeeReconciliationOwner: true });
	});

	it('keeps fee ownership on a Seller when its Buyer counterpart is outside the filters', async () => {
		const pairedTransaction = transaction(OnChainState.FundsLocked, {
			paymentCurrentIds: ['seller-filtered-pair'],
			purchaseCurrentIds: ['buyer-filtered-out'],
			blockchainIdentifiers: {
				'seller-filtered-pair': 'chain-filtered-pair',
				'buyer-filtered-out': 'chain-filtered-pair',
			},
		});
		mockFindPayments.mockResolvedValue([
			{
				...paymentRecord('seller-filtered-pair', '2026-01-03T00:00:00.000Z'),
				blockchainIdentifier: 'chain-filtered-pair',
				CurrentTransaction: pairedTransaction,
			},
		]);
		mockFindPurchases.mockResolvedValue([]);

		const result = await queryReportPage(filters(), { Buyer: null, Seller: null }, 50);

		expect(result.records).toHaveLength(1);
		expect(result.records[0]).toMatchObject({ role: 'Seller', isFeeReconciliationOwner: true });
	});

	it('uses an injected transaction client for repeatable-read aggregate queries', async () => {
		const transactionPaymentFindMany = jest.fn() as AnyMock;
		const transactionPurchaseFindMany = jest.fn() as AnyMock;
		transactionPaymentFindMany.mockResolvedValue([]);
		transactionPurchaseFindMany.mockResolvedValue([]);

		await queryReportPage(filters(), { Buyer: null, Seller: null }, 50, {
			paymentRequest: { findMany: transactionPaymentFindMany },
			purchaseRequest: { findMany: transactionPurchaseFindMany },
		} as never);

		expect(transactionPaymentFindMany).toHaveBeenCalledTimes(1);
		expect(transactionPurchaseFindMany).toHaveBeenCalledTimes(1);
		expect(mockFindPayments).not.toHaveBeenCalled();
		expect(mockFindPurchases).not.toHaveBeenCalled();
	});
});

describe('queryReportFeeComponentClosure', () => {
	it('loads a filtered transitive shared-fee component', async () => {
		const relatedTransaction = (id: string, relatedIds: string[], blockchainIdentifiers: Record<string, string>) => ({
			...transaction(OnChainState.Withdrawn, {
				paymentHistoryIds: relatedIds,
				blockchainIdentifiers,
			}),
			id,
			txHash: `hash-${id}`,
		});
		const identifiers = { a: 'payment-a', b: 'payment-b', c: 'payment-c' };
		const txAB = relatedTransaction('ab', ['a', 'b'], identifiers);
		const txBC = relatedTransaction('bc', ['b', 'c'], identifiers);
		const records = [
			{
				...paymentRecord('a', '2026-01-03T00:00:00.000Z'),
				blockchainIdentifier: 'payment-a',
				CurrentTransaction: txAB,
			},
			{
				...paymentRecord('b', '2026-01-02T00:00:00.000Z'),
				blockchainIdentifier: 'payment-b',
				CurrentTransaction: txAB,
				TransactionHistory: [txBC],
			},
			{
				...paymentRecord('c', '2026-01-01T00:00:00.000Z'),
				blockchainIdentifier: 'payment-c',
				CurrentTransaction: txBC,
			},
		];
		mockFindPayments.mockImplementation(({ where }) => {
			const keys = where.blockchainIdentifier?.in as string[] | undefined;
			return keys == null
				? records.slice(0, 2)
				: records.filter((record) => keys.includes(record.blockchainIdentifier));
		});
		mockFindPurchases.mockResolvedValue([]);
		mockIndexedTransactions([txAB, txBC]);

		const page = await queryReportPage(filters({ roles: ['Seller'] }), { Buyer: null, Seller: null }, 1);
		const closure = await queryReportFeeComponentClosure(page.records, filters({ roles: ['Seller'] }));

		expect(closure.map((record) => record.blockchainIdentifier).sort()).toEqual([
			'payment-a',
			'payment-b',
			'payment-c',
		]);
		await expect(
			queryReportFeeComponentClosure(page.records, filters({ roles: ['Seller'] }), undefined, {
				maxSerializedBytes: 1,
			}),
		).rejects.toMatchObject({ status: 413 });
		await expect(
			queryReportFeeComponentClosure(page.records, filters({ roles: ['Seller'] }), undefined, {
				maxQueryRows: 1,
			}),
		).rejects.toMatchObject({ status: 413 });
	});
});
