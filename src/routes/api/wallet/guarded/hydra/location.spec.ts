import { beforeEach, describe, expect, it, jest } from '@jest/globals';

type AsyncFn = (...args: unknown[]) => Promise<unknown>;
const mockHeads = jest.fn<AsyncFn>();
const mockGetNode = jest.fn<(id: string) => unknown>();
const mockPending = jest.fn<AsyncFn>();

jest.unstable_mockModule('@masumi/payment-core/db', () => ({ prisma: { hydraHead: { findMany: mockHeads } } }));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({ logger: { warn: jest.fn() } }));
jest.unstable_mockModule('@/lib/hydra/hydra/pending-commit', () => ({ fetchPendingCommitRefs: mockPending }));
jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({ getNode: mockGetNode }),
}));

const { findGuardedWalletInHead } = await import('./location');

const guarded = { policyId: 'aa'.repeat(28), stateTokenName: 'bb'.repeat(32) };
const unit = `${guarded.policyId}${guarded.stateTokenName}`;
const wallet = {
	input: { txHash: 'cc'.repeat(32), outputIndex: 1 },
	output: {
		address: 'addr_script',
		amount: [
			{ unit: 'lovelace', quantity: '85000000' },
			{ unit, quantity: '1' },
		],
	},
};
const pendingTopup = {
	input: { txHash: 'dd'.repeat(32), outputIndex: 0 },
	output: { address: 'addr_agent', amount: [{ unit: 'lovelace', quantity: '10000000' }] },
};
const node = (id: string) => ({ id, snapshotUTxO: () => Promise.resolve([wallet, pendingTopup]) });

beforeEach(() => {
	jest.clearAllMocks();
	mockHeads.mockResolvedValue([{ id: 'head-1' }]);
	mockGetNode.mockImplementation((id) => node(id));
	mockPending.mockResolvedValue([]);
});

describe('findGuardedWalletInHead', () => {
	it('skips a head that has approved but not finalized the wallet deposit', async () => {
		mockPending.mockResolvedValue([`${'cc'.repeat(32)}#1`]);
		await expect(findGuardedWalletInHead('hw-1', guarded)).resolves.toBeNull();
	});

	it('still reports the head that holds the wallet when its head state cannot be read', async () => {
		mockPending.mockRejectedValue(new Error('node down'));
		await expect(findGuardedWalletInHead('hw-1', guarded)).resolves.toMatchObject({
			hydraHeadId: 'head-1',
			snapshot: [wallet, pendingTopup],
			isCommitStateKnown: false,
		});
	});

	it('drops pending UTxOs from the snapshot used to pick collateral', async () => {
		mockPending.mockResolvedValue([`${'dd'.repeat(32)}#0`]);
		const found = await findGuardedWalletInHead('hw-1', guarded);
		expect(found?.snapshot).toEqual([wallet]);
		expect(found?.isCommitStateKnown).toBe(true);
	});
});
