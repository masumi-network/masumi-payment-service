import { beforeEach, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { testEndpoint } from 'express-zod-api';
import { ApiKeyStatus, Network, OnChainState } from '@/generated/prisma/client';

type FundRow = { unit: string; amount: bigint };
type Row = {
	id: string;
	blockchainIdentifier: string;
	agentIdentifier: string | null;
	agentIdentifierSyncedAt: Date | null;
	payByTime: bigint;
	onChainState: OnChainState;
	totalSellerCardanoFees: bigint;
	totalBuyerCardanoFees: bigint;
	RequestedFunds: FundRow[];
	PaidFunds: FundRow[];
	WithdrawnForBuyer: FundRow[];
	WithdrawnForSeller: FundRow[];
};
type Query = {
	take?: number;
	cursor?: { id: string };
	skip?: number;
	where: { OR?: Array<{ agentIdentifier?: string; agentIdentifierSyncedAt?: null }> };
};
const findPayments = jest.fn<(query: Query) => Promise<Row[]>>();
const findPurchases = jest.fn<(query: Query) => Promise<Row[]>>();
jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		apiKey: {
			findUnique: async () => ({
				id: 'earnings-test-key',
				status: ApiKeyStatus.Active,
				canRead: true,
				canPay: false,
				canAdmin: true,
				usageLimited: false,
				networkLimit: [],
				WalletScopes: [],
				X402WalletScopes: [],
			}),
		},
		paymentRequest: { findMany: findPayments },
		purchaseRequest: { findMany: findPurchases },
	},
}));
jest.unstable_mockModule('@masumi/payment-core/blockchain-identifier', () => ({
	decodeBlockchainIdentifier: (blockchainIdentifier: string) => ({ agentIdentifier: blockchainIdentifier }),
}));
const { getPaymentIncome } = await import('./payments/income');
const { postPurchaseSpending } = await import('./purchases/spending');
const { EARNINGS_QUERY_BATCH_SIZE } = await import('@/utils/earnings-helpers');
const agent = 'a'.repeat(57);
const otherAgent = 'b'.repeat(57);
const endpoints = [
	{ name: 'income', endpoint: getPaymentIncome, query: findPayments, total: 'TotalIncome', daily: 'DailyIncome' },
	{ name: 'spending', endpoint: postPurchaseSpending, query: findPurchases, total: 'TotalSpend', daily: 'DailySpend' },
];
const row = (id: number, state: OnChainState = OnChainState.Withdrawn): Row => ({
	id: String(id).padStart(6, '0'),
	blockchainIdentifier: agent,
	agentIdentifier: agent,
	agentIdentifierSyncedAt: new Date('2025-01-01'),
	payByTime: BigInt(Date.parse('2025-01-31T23:30:00Z')),
	onChainState: state,
	totalSellerCardanoFees: 2n,
	totalBuyerCardanoFees: 2n,
	RequestedFunds: [{ unit: '', amount: 10n }],
	PaidFunds: [{ unit: '', amount: 10n }],
	WithdrawnForBuyer: [],
	WithdrawnForSeller: [],
});
const pageRows = (rows: Row[]) => async (query: Query) => {
	const matches = query.where.OR
		? rows.filter((item) => item.agentIdentifier === agent || item.agentIdentifierSyncedAt === null)
		: rows;
	const cursorIndex = query.cursor ? matches.findIndex((item) => item.id === query.cursor?.id) : 0;
	const start = cursorIndex + (query.skip ?? 0);
	return matches.slice(start, query.take == null ? undefined : start + query.take);
};
const invoke = (endpoint: (typeof endpoints)[number]['endpoint'], agentIdentifier: string | null = null) =>
	testEndpoint({
		endpoint,
		requestProps: {
			method: 'POST',
			headers: { token: 'earnings-test-key' },
			body: { network: Network.Preprod, agentIdentifier, timeZone: 'Asia/Singapore' },
		},
		responseOptions: { eventEmitter: EventEmitter },
	});
beforeEach(() => {
	findPayments.mockReset().mockResolvedValue([]);
	findPurchases.mockReset().mockResolvedValue([]);
});

// Invariant: every history row contributes once, including rows tied at a page boundary.
it.each(endpoints)('$name totals tied rows across page boundaries', async ({ endpoint, query, total, daily }) => {
	const rows = Array.from({ length: EARNINGS_QUERY_BATCH_SIZE + 1 }, (_, index) => row(index));
	query.mockImplementation(pageRows(rows));
	const { responseMock } = await invoke(endpoint);
	expect(responseMock.statusCode).toBe(200);
	const output = responseMock._getJSONData().data;
	expect(output.totalTransactions).toBe(rows.length);
	expect(output[total]).toEqual({ Units: [{ unit: '', amount: rows.length * 10 }], blockchainFees: rows.length * 2 });
	expect(output[daily]).toEqual([
		expect.objectContaining({ Units: [{ unit: '', amount: rows.length * 10 }], blockchainFees: rows.length * 2 }),
	]);
	expect(query).toHaveBeenCalledTimes(2);
	expect(query.mock.calls[0][0]).toMatchObject({
		take: EARNINGS_QUERY_BATCH_SIZE,
		orderBy: [{ payByTime: 'asc' }, { id: 'asc' }],
	});
	expect(query.mock.calls[1][0]).toMatchObject({ cursor: { id: rows[EARNINGS_QUERY_BATCH_SIZE - 1].id }, skip: 1 });
});

// Invariant: SQL removes known nonmatches while the decoder still checks unsynced rows.
it.each(endpoints)('$name filters known agents and keeps the legacy fallback', async ({ endpoint, query, total }) => {
	const syncedMatch = row(0);
	const legacyMatch = { ...row(1), agentIdentifier: null, agentIdentifierSyncedAt: null };
	const legacyOther = {
		...row(2),
		blockchainIdentifier: otherAgent,
		agentIdentifier: null,
		agentIdentifierSyncedAt: null,
	};
	const syncedOther = { ...row(3), blockchainIdentifier: otherAgent, agentIdentifier: otherAgent };
	query.mockImplementation(pageRows([syncedMatch, legacyMatch, legacyOther, syncedOther]));
	const { responseMock } = await invoke(endpoint, agent);
	expect(responseMock.statusCode).toBe(200);
	expect(responseMock._getJSONData().data.totalTransactions).toBe(2);
	expect(responseMock._getJSONData().data[total].Units).toEqual([{ unit: '', amount: 20 }]);
	expect(query.mock.calls[0][0].where.OR).toEqual([{ agentIdentifier: agent }, { agentIdentifierSyncedAt: null }]);
});

it.each(endpoints)(
	'$name preserves refunds, disputed splits, pending funds, and invalid-row counts',
	async ({ endpoint, query, total }) => {
		const rows = [
			row(0),
			row(1, OnChainState.RefundWithdrawn),
			{
				...row(2, OnChainState.DisputedWithdrawn),
				WithdrawnForBuyer: [{ unit: '', amount: 3n }],
				WithdrawnForSeller: [{ unit: '', amount: 7n }],
			},
			row(3, OnChainState.FundsLocked),
			row(4, OnChainState.FundsOrDatumInvalid),
		];
		query.mockImplementation(pageRows(rows));
		const { responseMock } = await invoke(endpoint);
		expect(responseMock.statusCode).toBe(200);
		const output = responseMock._getJSONData().data;
		expect(output.totalTransactions).toBe(5);
		expect(output[total].Units).toEqual([{ unit: '', amount: 17 }]);
		expect(output.TotalRefunded.Units).toEqual([{ unit: '', amount: 13 }]);
		expect(output.TotalPending).toEqual({ Units: [{ unit: '', amount: 10 }], blockchainFees: 2 });
		expect(output[total].blockchainFees + output.TotalRefunded.blockchainFees).toBe(6);
	},
);

it('shares capacity across income and spending and admits work after completion', async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let notifyStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		notifyStarted = resolve;
	});
	let queries = 0;
	const query = async () => {
		queries += 1;
		if (queries === 4) notifyStarted();
		await gate;
		return [];
	};
	findPayments.mockImplementation(query);
	findPurchases.mockImplementation(query);
	const active = [
		invoke(getPaymentIncome),
		invoke(postPurchaseSpending),
		invoke(getPaymentIncome),
		invoke(postPurchaseSpending),
	];
	try {
		await Promise.race([started, Promise.all(active)]);
		expect(queries).toBe(4);
		const blocked = await invoke(postPurchaseSpending);
		expect(blocked.responseMock.statusCode).toBe(503);
		expect(blocked.responseMock.getHeader('retry-after')).toBe('1');
		expect(queries).toBe(4);
	} finally {
		release();
		await Promise.all(active);
	}
	expect((await invoke(getPaymentIncome)).responseMock.statusCode).toBe(200);
});
