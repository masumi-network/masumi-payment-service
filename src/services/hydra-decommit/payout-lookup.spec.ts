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
const mockFindPayout = jest.fn() as AnyMock;
const mockTxs = jest.fn() as AnyMock;
const mockBlocks = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/config', () => ({ CONFIG: { BLOCK_CONFIRMATIONS_THRESHOLD: 5 } }));
jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraDecommit: {
			findUnique: async () => row,
			findMany: mockFindMany,
			updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
				if (where.id !== row.id || (where.status && where.status !== row.status)) return { count: 0 };
				if (typeof where.l1TxId === 'string' && where.l1TxId !== row.l1TxId) return { count: 0 };
				if (where.l1TxId === null && row.l1TxId !== null) return { count: 0 };
				Object.assign(row, data);
				return { count: 1 };
			},
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
	mockFindMany.mockImplementation(({ where }: { where: Record<string, unknown> }) => {
		if (where.status === 'Approved') return Promise.resolve(row.status === 'Approved' ? [row] : []);
		if (where.status === 'Finalized') return Promise.resolve(row.status === 'Finalized' ? [row] : []);
		return Promise.resolve([]);
	});
	mockFindPayout.mockResolvedValue(TX);
	mockTxs.mockResolvedValue({ hash: TX, block: 'block-1', valid_contract: true });
	mockBlocks.mockResolvedValue({ confirmations: DECOMMIT_MIN_CONFIRMATIONS - 1 });
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
