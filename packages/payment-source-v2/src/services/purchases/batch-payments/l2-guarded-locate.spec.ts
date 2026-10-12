import { beforeEach, describe, expect, it, jest } from '@jest/globals';

type AsyncFn = (...args: unknown[]) => Promise<unknown>;
const mockSnapshot = jest.fn<AsyncFn>();
const mockOpenWithdraw = jest.fn<AsyncFn>();
const mockGetNode = jest.fn<(id: string) => unknown>();
const mockHeadState = jest.fn<AsyncFn>();
const mockPendingRefs = jest.fn<(state: unknown) => string[]>();

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { guardedHydraTransfer: { findFirst: mockOpenWithdraw } },
}));
jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({ getNode: mockGetNode }),
}));

jest.unstable_mockModule('@/lib/hydra/hydra/pending-commit', () => ({
	fetchPendingCommitRefs: async (node: { get: (url: string) => Promise<unknown> }) =>
		mockPendingRefs(await node.get('/head')),
}));

const { locateGuardedWalletForLock, signedSnapshotHoldingWallet } = await import('./l2-guarded-lock-execute');

const guarded = { id: 'gw-1', policyId: 'aa'.repeat(28), stateTokenName: 'bb'.repeat(32) };
const unit = `${guarded.policyId}${guarded.stateTokenName}`;
const walletUtxo = {
	input: { txHash: 'cc'.repeat(32), outputIndex: 0 },
	output: {
		address: 'addr_script',
		amount: [
			{ unit: 'lovelace', quantity: '90000000' },
			{ unit, quantity: '1' },
		],
	},
};
const other = {
	input: { txHash: 'dd'.repeat(32), outputIndex: 0 },
	output: { address: 'addr_agent', amount: [{ unit: 'lovelace', quantity: '10000000' }] },
};

beforeEach(() => {
	jest.clearAllMocks();
	mockGetNode.mockReturnValue({ snapshotUTxO: mockSnapshot, get: mockHeadState });
	mockHeadState.mockResolvedValue({});
	mockPendingRefs.mockReturnValue([]);
	mockSnapshot.mockResolvedValue([other, walletUtxo]);
	mockOpenWithdraw.mockResolvedValue(null);
});

describe('locateGuardedWalletForLock', () => {
	it('returns the wallet UTxO and the snapshot when the head holds it', async () => {
		await expect(locateGuardedWalletForLock(guarded, 'head-1')).resolves.toEqual({
			walletUtxo,
			snapshot: [other, walletUtxo],
		});
	});

	it('reports moving while a withdraw of the wallet is open', async () => {
		mockOpenWithdraw.mockResolvedValue({ id: 'tr-1' });
		await expect(locateGuardedWalletForLock(guarded, 'head-1')).resolves.toBe('moving');
	});

	it('reports moving while the head has approved but not finalized the deposit', async () => {
		mockPendingRefs.mockReturnValue([`${'cc'.repeat(32)}#0`]);
		await expect(locateGuardedWalletForLock(guarded, 'head-1')).resolves.toBe('moving');
	});

	it('throws when the head state cannot be read, so the caller treats it as indeterminate', async () => {
		mockHeadState.mockRejectedValue(new Error('node down'));
		await expect(locateGuardedWalletForLock(guarded, 'head-1')).rejects.toThrow('node down');
	});

	it('returns null when the head does not hold the state token', async () => {
		mockSnapshot.mockResolvedValue([other]);
		await expect(locateGuardedWalletForLock(guarded, 'head-1')).resolves.toBeNull();
		expect(mockOpenWithdraw).not.toHaveBeenCalled();
	});

	it('returns null when no node serves the head', async () => {
		mockGetNode.mockReturnValue(null);
		await expect(locateGuardedWalletForLock(guarded, 'head-1')).resolves.toBeNull();
	});
});

describe('signedSnapshotHoldingWallet', () => {
	const headId = 'ab'.repeat(28);
	const walletRef = `${'cc'.repeat(32)}#0`;
	const confirmed = (utxoRefs: string[], snapshotHeadId = headId) => ({
		signatures: { multiSignature: ['ef'.repeat(64)] },
		snapshot: {
			headId: snapshotHeadId,
			version: 1,
			number: 2,
			accumulator: 'ac'.repeat(32),
			utxo: Object.fromEntries(utxoRefs.map((ref) => [ref, { address: 'addr_test', value: { lovelace: 90000000n } }])),
			utxoToCommit: null,
			utxoToDecommit: null,
			depositTxId: null,
		},
	});

	it('returns the confirmed snapshot from /snapshot when it holds the wallet', async () => {
		mockHeadState.mockResolvedValue(confirmed([walletRef]));
		const proof = await signedSnapshotHoldingWallet('head-1', headId, walletRef);
		expect(mockHeadState).toHaveBeenCalledWith('/snapshot');
		expect(proof.utxo[walletRef].value.lovelace).toBe('90000000');
	});

	it('accepts a snapshot that holds the wallet as a deposit still pending in the commit set', async () => {
		const pending = confirmed([]);
		pending.snapshot.utxoToCommit = { [walletRef]: { address: 'addr_test', value: { lovelace: 90000000n } } } as never;
		mockHeadState.mockResolvedValue(pending);
		const proof = await signedSnapshotHoldingWallet('head-1', headId, walletRef);
		expect(proof.utxoToCommit?.[walletRef].value.lovelace).toBe('90000000');
	});

	it('refuses a snapshot that does not hold the wallet yet', async () => {
		mockHeadState.mockResolvedValue(confirmed([`${'dd'.repeat(32)}#0`]));
		await expect(signedSnapshotHoldingWallet('head-1', headId, walletRef)).rejects.toThrow('does not hold');
	});

	it('refuses a snapshot of another head', async () => {
		mockHeadState.mockResolvedValue(confirmed([walletRef], 'cd'.repeat(28)));
		await expect(signedSnapshotHoldingWallet('head-1', headId, walletRef)).rejects.toThrow('another head');
	});
});
