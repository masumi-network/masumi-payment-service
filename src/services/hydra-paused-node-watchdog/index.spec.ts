import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockFindUnique = jest.fn<(_args: unknown) => Promise<unknown>>();
const mockFindMany = jest.fn<(_args: unknown) => Promise<unknown[]>>();
const mockObserve = jest.fn<(_args: unknown) => Promise<{ isOpen: boolean; latestTxHash: string }>>();
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

const { checkDisabledHeadOnChain, watchDisabledHeadsOnChain } = await import('./index');

const HEAD = {
	headIdentifier: 'ab'.repeat(28),
	HydraRelation: {
		network: 'Mainnet',
		LocalHotWallet: { PaymentSource: { PaymentSourceConfig: { rpcProviderApiKey: 'key' } } },
	},
};

beforeEach(() => {
	jest.clearAllMocks();
	mockFindUnique.mockResolvedValue(HEAD);
	mockSetRunning.mockResolvedValue('requested');
});

describe('checkDisabledHeadOnChain', () => {
	it('leaves the node stopped while the head is still open on chain', async () => {
		mockObserve.mockResolvedValue({ isOpen: true, latestTxHash: 'aa' });

		await expect(checkDisabledHeadOnChain('head-1')).resolves.toEqual({
			isOpenOnChain: true,
			latestTxHash: 'aa',
			nodeStart: null,
		});
		expect(mockSetRunning).not.toHaveBeenCalled();
	});

	// The node must be up to contest a stale close before the deadline.
	it('starts the node once the head is no longer open on chain', async () => {
		mockObserve.mockResolvedValue({ isOpen: false, latestTxHash: 'bb' });

		await expect(checkDisabledHeadOnChain('head-1')).resolves.toEqual({
			isOpenOnChain: false,
			latestTxHash: 'bb',
			nodeStart: 'requested',
		});
		expect(mockSetRunning).toHaveBeenCalledWith('head-1', true, expect.any(String));
	});

	it('refuses a head without an L1 observer key', async () => {
		mockFindUnique.mockResolvedValue({
			...HEAD,
			HydraRelation: { ...HEAD.HydraRelation, LocalHotWallet: { PaymentSource: { PaymentSourceConfig: null } } },
		});

		await expect(checkDisabledHeadOnChain('head-1')).rejects.toThrow(/no independent L1 observer/);
	});
});

describe('watchDisabledHeadsOnChain', () => {
	it('checks every disabled head and keeps going past a failed lookup', async () => {
		mockFindMany.mockResolvedValue([{ id: 'head-1' }, { id: 'head-2' }, { id: 'head-3' }]);
		mockObserve
			.mockRejectedValueOnce(new Error('blockfrost down'))
			.mockResolvedValueOnce({ isOpen: false, latestTxHash: 'bb' })
			.mockResolvedValueOnce({ isOpen: true, latestTxHash: 'cc' });

		await expect(watchDisabledHeadsOnChain()).resolves.toBe(1);
		expect(mockObserve).toHaveBeenCalledTimes(3);
		expect(mockSetRunning).toHaveBeenCalledWith('head-2', true, expect.any(String));
	});
});
