import { beforeEach, describe, expect, it, jest } from '@jest/globals';

type AnyMock = jest.Mock<(...args: any[]) => any>;
const TX = 'a'.repeat(64);
const HEAD = 'b'.repeat(56);
const now = new Date('2026-10-26T08:00:00Z');

const row = {
	id: 'withdrawal-1',
	hydraHeadId: 'head-1',
	status: 'Approved',
	l1ObservedAt: now,
	l1CheckedAt: null as Date | null,
	finalizedAt: null as Date | null,
	l1TxId: null as string | null,
	createdAt: new Date('2026-10-26T07:00:00Z'),
	approvedAt: new Date('2026-10-26T07:01:00Z'),
	settledLovelace: 9_000_000n,
	settledAssets: {},
	destinationAddress: 'addr1test',
	HydraHead: { headIdentifier: HEAD },
	LocalParticipant: {
		Wallet: { PaymentSource: { network: 'Mainnet', PaymentSourceConfig: { rpcProviderApiKey: 'key' } } },
	},
};

const mockFindMany = jest.fn() as AnyMock;
const mockFindUnique = jest.fn() as AnyMock;
const mockUpdateMany = jest.fn() as AnyMock;
const mockFindPayout = jest.fn() as AnyMock;
const mockTxs = jest.fn() as AnyMock;
const mockBlocks = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/config', () => ({ CONFIG: { BLOCK_CONFIRMATIONS_THRESHOLD: 5 } }));
jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraDecommit: {
			findUnique: mockFindUnique,
			findMany: mockFindMany,
			updateMany: mockUpdateMany,
		},
	},
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('@/utils/blockfrost', () => ({
	getBlockfrostInstance: () => ({ txs: mockTxs, blocks: mockBlocks }),
}));
jest.unstable_mockModule('./l1-payout', () => ({
	decommitPayoutSearchBounds: () => ({ notBefore: row.createdAt, exclude: new Set<string>() }),
	findDecommitPayoutTx: mockFindPayout,
}));

const { resolveDecommitPayoutTx, reconcileUnidentifiedDecommitPayouts, DECOMMIT_MIN_CONFIRMATIONS } =
	await import('./payout-lookup');

beforeEach(() => {
	jest.clearAllMocks();
	row.status = 'Approved';
	row.l1ObservedAt = now;
	row.l1CheckedAt = null;
	row.finalizedAt = null;
	row.l1TxId = null;
	mockFindUnique.mockResolvedValue(row);
	mockUpdateMany.mockImplementation(
		({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
			if (where.id !== row.id || (where.status && where.status !== row.status)) return Promise.resolve({ count: 0 });
			if (typeof where.l1TxId === 'string' && where.l1TxId !== row.l1TxId) return Promise.resolve({ count: 0 });
			if (where.l1TxId === null && row.l1TxId !== null) return Promise.resolve({ count: 0 });
			Object.assign(row, data);
			return Promise.resolve({ count: 1 });
		},
	);
	mockFindMany.mockImplementation(({ where }: { where: Record<string, unknown> }) => {
		if (where.status === 'Approved') return Promise.resolve(row.status === 'Approved' ? [row] : []);
		if (where.status === 'Finalized') return Promise.resolve(row.status === 'Finalized' ? [row] : []);
		return Promise.resolve([]);
	});
	mockFindPayout.mockResolvedValue(TX);
	mockTxs.mockResolvedValue({ hash: TX, block: 'block-1', valid_contract: true });
	mockBlocks.mockResolvedValue({ confirmations: DECOMMIT_MIN_CONFIRMATIONS - 1 });
});

type PayoutRow = typeof row;
type RetryQuery = {
	where: { status: string };
	orderBy: { l1CheckedAt: 'asc' | { sort: 'asc'; nulls: 'first' | 'last' } };
	take: number;
};

/** Model PostgreSQL's NULLS LAST default for ascending timestamps at the DB boundary. */
function useRetryRows(rows: PayoutRow[]): void {
	mockFindUnique.mockImplementation(({ where }: { where: { id: string } }) =>
		Promise.resolve(rows.find((candidate) => candidate.id === where.id)),
	);
	mockFindMany.mockImplementation(({ where, orderBy, take }: RetryQuery) => {
		if (!where.status) return Promise.resolve([]);
		const nullsFirst = typeof orderBy.l1CheckedAt === 'object' && orderBy.l1CheckedAt.nulls === 'first';
		return Promise.resolve(
			rows
				.filter((candidate) => candidate.status === where.status)
				.sort((left, right) => {
					if (left.l1CheckedAt === null && right.l1CheckedAt === null) return 0;
					if (left.l1CheckedAt === null) return nullsFirst ? -1 : 1;
					if (right.l1CheckedAt === null) return nullsFirst ? 1 : -1;
					return left.l1CheckedAt.getTime() - right.l1CheckedAt.getTime();
				})
				.slice(0, take),
		);
	});
	mockUpdateMany.mockImplementation(
		({ where, data }: { where: { id: string; status?: string; l1TxId?: string }; data: Partial<PayoutRow> }) => {
			const target = rows.find(
				(candidate) =>
					candidate.id === where.id &&
					(where.status === undefined || candidate.status === where.status) &&
					(where.l1TxId === undefined || candidate.l1TxId === where.l1TxId),
			);
			if (!target) return Promise.resolve({ count: 0 });
			Object.assign(target, data);
			return Promise.resolve({ count: 1 });
		},
	);
}

describe('payout retry fairness', () => {
	it('checks never-attempted Approved payouts before retrying a full batch of stuck rows', async () => {
		const rows = Array.from({ length: 11 }, (_, index) => ({ ...row, id: `withdrawal-${index}` }));
		useRetryRows(rows);
		mockFindPayout.mockResolvedValue(null);

		await reconcileUnidentifiedDecommitPayouts();
		await reconcileUnidentifiedDecommitPayouts();

		expect(rows.every((candidate) => candidate.l1CheckedAt !== null)).toBe(true);
	});

	it.each(['unavailable observer', 'missing observer configuration'])(
		'continues past a full batch of Finalized payouts with %s',
		async (failure) => {
			const rows = Array.from({ length: 11 }, (_, index) => ({
				...row,
				id: `withdrawal-${index}`,
				status: 'Finalized',
				l1TxId: TX,
				finalizedAt: new Date(),
				l1CheckedAt: new Date(index),
				LocalParticipant: {
					Wallet: {
						PaymentSource: {
							...row.LocalParticipant.Wallet.PaymentSource,
							PaymentSourceConfig: { rpcProviderApiKey: failure === 'missing observer configuration' ? '' : 'key' },
						},
					},
				},
			}));
			useRetryRows(rows);
			mockTxs.mockRejectedValue({ status_code: 503 });

			await reconcileUnidentifiedDecommitPayouts();
			await reconcileUnidentifiedDecommitPayouts();

			expect(rows.every((candidate) => candidate.l1CheckedAt!.getTime() > rows.length)).toBe(true);
			expect(rows.every((candidate) => candidate.status === 'Finalized')).toBe(true);
		},
	);
});

const distributed = { lovelace: 9_000_000n, assets: {} };

describe('independent decommit finality', () => {
	it('keeps the payout Approved below required depth, then promotes it', async () => {
		await resolveDecommitPayoutTx({ decommitId: row.id, distributed });
		expect(row.status).toBe('Approved');
		expect(row.l1TxId).toBe(TX);
		expect(row.finalizedAt).toBeNull();
		mockBlocks.mockResolvedValue({ confirmations: DECOMMIT_MIN_CONFIRMATIONS });
		await resolveDecommitPayoutTx({ decommitId: row.id, distributed });
		expect(row.status).toBe('Finalized');
		expect(row.finalizedAt).toBeInstanceOf(Date);
	});

	it('never promotes a payout whose transaction identity or phase-2 result disagrees', async () => {
		mockTxs.mockResolvedValue({ hash: 'c'.repeat(64), block: 'block-1', valid_contract: true });
		mockBlocks.mockResolvedValue({ confirmations: DECOMMIT_MIN_CONFIRMATIONS });
		await resolveDecommitPayoutTx({ decommitId: row.id, distributed });
		expect(row.status).toBe('Approved');
		expect(row.l1TxId).toBeNull();
	});

	it('does not trust a cached legacy payout hash without fresh decrement proof', async () => {
		row.l1TxId = TX;
		mockFindPayout.mockResolvedValue(null);
		mockBlocks.mockResolvedValue({ confirmations: DECOMMIT_MIN_CONFIRMATIONS });
		await resolveDecommitPayoutTx({ decommitId: row.id, distributed });
		expect(row.status).toBe('Approved');
		expect(mockTxs).not.toHaveBeenCalled();
	});

	it('keeps the withdrawal Approved when the independent observer is unavailable', async () => {
		mockTxs.mockRejectedValue({ status_code: 503 });
		await expect(resolveDecommitPayoutTx({ decommitId: row.id, distributed })).rejects.toMatchObject({
			status_code: 503,
		});
		expect(row.status).toBe('Approved');
		expect(row.finalizedAt).toBeNull();
	});

	it('moves a recent Finalized payout back to Approved after L1 depth is lost', async () => {
		row.status = 'Finalized';
		row.l1TxId = TX;
		row.finalizedAt = now;
		await reconcileUnidentifiedDecommitPayouts();
		expect(row.status).toBe('Approved');
		expect(row.finalizedAt).toBeNull();
		expect(row.l1TxId).toBeNull();
	});

	it('reverts a recent Finalized payout when its L1 transaction disappears', async () => {
		row.status = 'Finalized';
		row.l1TxId = TX;
		row.finalizedAt = now;
		mockTxs.mockRejectedValue({ status_code: 404 });
		await reconcileUnidentifiedDecommitPayouts();
		expect(row.status).toBe('Approved');
		expect(row.l1TxId).toBeNull();
		expect(row.l1ObservedAt).toEqual(now);
	});
});
