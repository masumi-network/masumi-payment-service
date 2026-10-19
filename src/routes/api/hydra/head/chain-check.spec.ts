import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockFindUnique = jest.fn<(_args: unknown) => Promise<unknown>>();
const mockObserve = jest.fn<(_args: unknown) => Promise<{ state: string; latestTxHash: string }>>();

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraHead: { findUnique: mockFindUnique } },
}));
jest.unstable_mockModule('@/lib/hydra/hydra/head-init-validation', () => ({
	HydraHeadInitObservationError: class extends Error {},
	observeHydraHeadIsOpenOnChain: mockObserve,
}));
jest.unstable_mockModule('@/utils/blockfrost', () => ({
	getBlockfrostInstance: () => ({}),
}));

const { readHeadChainState } = await import('./chain-check');

const HEAD = {
	headIdentifier: 'ab'.repeat(28),
	HydraRelation: {
		network: 'Mainnet',
		LocalHotWallet: { PaymentSource: { PaymentSourceConfig: { rpcProviderApiKey: 'key' } } },
	},
};

beforeEach(() => {
	jest.resetAllMocks();
});

describe('readHeadChainState', () => {
	it('reads the head through the independent observer', async () => {
		mockFindUnique.mockResolvedValue(HEAD);
		mockObserve.mockResolvedValue({ state: 'closed', latestTxHash: 'bb' });

		await expect(readHeadChainState('head-1')).resolves.toEqual({ state: 'closed', latestTxHash: 'bb' });
		expect(mockObserve).toHaveBeenCalledWith(expect.objectContaining({ headId: HEAD.headIdentifier }));
	});

	it('reports a missing head as not found', async () => {
		mockFindUnique.mockResolvedValue(null);

		await expect(readHeadChainState('head-1')).rejects.toMatchObject({ statusCode: 404 });
	});

	it('refuses a head whose identifier was never observed', async () => {
		mockFindUnique.mockResolvedValue({ ...HEAD, headIdentifier: null });

		await expect(readHeadChainState('head-1')).rejects.toMatchObject({ statusCode: 409 });
		expect(mockObserve).not.toHaveBeenCalled();
	});

	it('refuses a head without an L1 observer key', async () => {
		mockFindUnique.mockResolvedValue({
			...HEAD,
			HydraRelation: { ...HEAD.HydraRelation, LocalHotWallet: { PaymentSource: { PaymentSourceConfig: null } } },
		});

		await expect(readHeadChainState('head-1')).rejects.toMatchObject({ statusCode: 409 });
	});
});
