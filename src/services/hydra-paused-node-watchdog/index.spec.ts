import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockFindUnique = jest.fn<(_args: unknown) => Promise<unknown>>();
const mockFindMany = jest.fn<(_args: unknown) => Promise<unknown[]>>();
const mockObserve = jest.fn<(_args: unknown) => Promise<{ state: string; latestTxHash: string }>>();
const mockSetRunning = jest.fn<(..._args: unknown[]) => Promise<string>>();

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraHead: { findUnique: mockFindUnique, findMany: mockFindMany } },
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('@/lib/hydra/hydra/head-init-validation', () => ({
	observeHydraHeadIsOpenOnChain: mockObserve,
}));
jest.unstable_mockModule('@/utils/blockfrost', () => ({
	getBlockfrostInstance: () => ({}),
}));
jest.unstable_mockModule('@/services/hydra-host/own-node-control', () => ({
	setOwnHeadNodeRunning: mockSetRunning,
}));

const { convergeDisabledHeadNode, watchDisabledHeadsOnChain } = await import('./index');

const HEAD = {
	headIdentifier: 'ab'.repeat(28),
	HydraRelation: {
		network: 'Mainnet',
		LocalHotWallet: { PaymentSource: { PaymentSourceConfig: { rpcProviderApiKey: 'key' } } },
	},
};

/** First read loads the head for the chain lookup; the second re-reads isEnabled. */
function headReads(isEnabled: boolean) {
	mockFindUnique.mockResolvedValueOnce(HEAD).mockResolvedValueOnce({ isEnabled });
}

beforeEach(() => {
	jest.resetAllMocks();
	mockSetRunning.mockResolvedValue('requested');
});

describe('convergeDisabledHeadNode', () => {
	// A running node keeps co-signing, so the counterparty keeps locking funds
	// in a head this side does not observe.
	it('stops the node of a disabled head that is still open on chain', async () => {
		headReads(false);
		mockObserve.mockResolvedValue({ state: 'open', latestTxHash: 'aa' });

		await expect(convergeDisabledHeadNode('head-1', 'test')).resolves.toEqual({
			chainState: 'open',
			latestTxHash: 'aa',
			nodeAction: 'stop',
			nodeOutcome: 'requested',
		});
		expect(mockSetRunning).toHaveBeenCalledWith('head-1', false, 'test');
	});

	it('reports a stop the Host refused', async () => {
		headReads(false);
		mockObserve.mockResolvedValue({ state: 'open', latestTxHash: 'aa' });
		mockSetRunning.mockResolvedValue('failed');

		await expect(convergeDisabledHeadNode('head-1', 'test')).resolves.toMatchObject({
			nodeAction: 'stop',
			nodeOutcome: 'failed',
		});
	});

	// An operator re-enable can land during the chain lookup.
	it('leaves the node of a head enabled again meanwhile', async () => {
		headReads(true);
		mockObserve.mockResolvedValue({ state: 'open', latestTxHash: 'aa' });

		await expect(convergeDisabledHeadNode('head-1', 'test')).resolves.toMatchObject({ nodeAction: null });
		expect(mockSetRunning).not.toHaveBeenCalled();
	});

	// The re-enable's start can reach the Host before this stop; nothing else
	// starts the node of an enabled head, so it must be started again here.
	it('starts the node again when the head was re-enabled during the stop', async () => {
		mockFindUnique
			.mockResolvedValueOnce(HEAD)
			.mockResolvedValueOnce({ isEnabled: false })
			.mockResolvedValueOnce({ isEnabled: true });
		mockObserve.mockResolvedValue({ state: 'open', latestTxHash: 'aa' });

		await expect(convergeDisabledHeadNode('head-1', 'test')).resolves.toMatchObject({
			nodeAction: 'start',
			nodeOutcome: 'requested',
		});
		expect(mockSetRunning).toHaveBeenNthCalledWith(1, 'head-1', false, 'test');
		expect(mockSetRunning).toHaveBeenNthCalledWith(2, 'head-1', true, expect.any(String));
	});

	// The node must be up to contest a stale close before the deadline.
	it('starts the node once the head is closed on chain', async () => {
		mockFindUnique.mockResolvedValueOnce(HEAD);
		mockObserve.mockResolvedValue({ state: 'closed', latestTxHash: 'bb' });

		await expect(convergeDisabledHeadNode('head-1', 'test')).resolves.toEqual({
			chainState: 'closed',
			latestTxHash: 'bb',
			nodeAction: 'start',
			nodeOutcome: 'requested',
		});
		expect(mockSetRunning).toHaveBeenCalledWith('head-1', true, expect.any(String));
	});

	it('does nothing for a fanned-out head', async () => {
		mockFindUnique.mockResolvedValueOnce(HEAD);
		mockObserve.mockResolvedValue({ state: 'gone', latestTxHash: 'cc' });

		await expect(convergeDisabledHeadNode('head-1', 'test')).resolves.toMatchObject({ nodeAction: null });
		expect(mockSetRunning).not.toHaveBeenCalled();
	});

	it('refuses a head without an L1 observer key', async () => {
		mockFindUnique.mockResolvedValueOnce({
			...HEAD,
			HydraRelation: { ...HEAD.HydraRelation, LocalHotWallet: { PaymentSource: { PaymentSourceConfig: null } } },
		});

		await expect(convergeDisabledHeadNode('head-1', 'test')).rejects.toMatchObject({ statusCode: 409 });
		expect(mockSetRunning).not.toHaveBeenCalled();
	});

	it('reports a missing head as not found', async () => {
		mockFindUnique.mockResolvedValueOnce(null);

		await expect(convergeDisabledHeadNode('head-1', 'test')).rejects.toMatchObject({ statusCode: 404 });
	});
});

describe('watchDisabledHeadsOnChain', () => {
	it('checks every disabled head and keeps going past a failed lookup', async () => {
		mockFindMany.mockResolvedValue([{ id: 'head-1' }, { id: 'head-2' }, { id: 'head-3' }]);
		mockFindUnique
			.mockResolvedValueOnce(HEAD)
			.mockResolvedValueOnce(HEAD)
			.mockResolvedValueOnce(HEAD)
			.mockResolvedValueOnce({ isEnabled: false });
		mockObserve
			.mockRejectedValueOnce(new Error('blockfrost down'))
			.mockResolvedValueOnce({ state: 'closed', latestTxHash: 'bb' })
			.mockResolvedValueOnce({ state: 'open', latestTxHash: 'cc' });

		await expect(watchDisabledHeadsOnChain()).resolves.toBe(1);
		expect(mockObserve).toHaveBeenCalledTimes(3);
		expect(mockSetRunning).toHaveBeenCalledWith('head-2', true, expect.any(String));
		expect(mockSetRunning).toHaveBeenCalledWith('head-3', false, expect.any(String));
	});
});
