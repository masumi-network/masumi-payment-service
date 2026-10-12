import { beforeEach, describe, expect, it, jest } from '@jest/globals';

type AsyncFn = (...args: unknown[]) => Promise<unknown>;
const mockLoadHotWallet = jest.fn<AsyncFn>();
const mockAssertNoOpenTransfer = jest.fn<AsyncFn>();
const mockFindInHead = jest.fn<AsyncFn>();
const mockInspect = jest.fn<AsyncFn>();
const mockDelete = jest.fn<AsyncFn>();

jest.unstable_mockModule('@masumi/payment-source-v2/smart-wallet/guarded-wallet', () => ({
	inspectGuardedWallet: mockInspect,
}));
jest.unstable_mockModule('./service', () => ({
	loadPurchasingHotWallet: mockLoadHotWallet,
	hotWalletBusyError: () => Object.assign(new Error('busy'), { status: 409 }),
}));
jest.unstable_mockModule('./hydra/location', () => ({ findGuardedWalletInHead: mockFindInHead }));
jest.unstable_mockModule('./hydra/transfers', () => ({
	assertNoOpenTransfer: mockAssertNoOpenTransfer,
	guardedWalletParams: () => ({}),
	withGuardedWalletLock: (_id: string, run: (tx: unknown) => Promise<unknown>) =>
		run({ guardedWallet: { delete: mockDelete } }),
}));

const { detachGuardedWallet } = await import('./detach');

const scope = { networkLimit: [], walletScopeIds: null } as never;
const idle = {
	id: 'hw-1',
	lockedAt: null,
	pendingTransactionId: null,
	GuardedWallet: { id: 'gw-1' },
	PaymentSource: { network: 'Preprod', PaymentSourceConfig: { rpcProviderApiKey: 'key' } },
};

beforeEach(() => {
	jest.clearAllMocks();
	mockLoadHotWallet.mockResolvedValue(idle);
	mockAssertNoOpenTransfer.mockResolvedValue(undefined);
	mockFindInHead.mockResolvedValue(null);
	mockInspect.mockResolvedValue({});
	mockDelete.mockResolvedValue({});
});

describe('detachGuardedWallet', () => {
	it('refuses while the hot wallet is locked by a batch', async () => {
		mockLoadHotWallet.mockResolvedValue({ ...idle, lockedAt: new Date() });
		await expect(detachGuardedWallet('hw-1', scope)).rejects.toMatchObject({ status: 409 });
		expect(mockDelete).not.toHaveBeenCalled();
	});

	it('refuses while a move of the wallet is open', async () => {
		mockAssertNoOpenTransfer.mockRejectedValue(Object.assign(new Error('open'), { status: 409 }));
		await expect(detachGuardedWallet('hw-1', scope)).rejects.toMatchObject({ status: 409 });
		expect(mockDelete).not.toHaveBeenCalled();
	});

	it('refuses while a head holds the wallet, whatever the records say', async () => {
		mockFindInHead.mockResolvedValue({ hydraHeadId: 'head-1' });
		await expect(detachGuardedWallet('hw-1', scope)).rejects.toMatchObject({ status: 409 });
		expect(mockDelete).not.toHaveBeenCalled();
	});

	it('refuses when L1 does not hold the wallet either', async () => {
		mockInspect.mockRejectedValue(new Error('No UTxO carries the token on L1'));
		await expect(detachGuardedWallet('hw-1', scope)).rejects.toMatchObject({ status: 409 });
		expect(mockDelete).not.toHaveBeenCalled();
	});

	it('deletes the row of an idle wallet on L1, re-checking open moves under the lock', async () => {
		await detachGuardedWallet('hw-1', scope);
		expect(mockDelete).toHaveBeenCalledWith({ where: { hotWalletId: 'hw-1' } });
		expect(mockAssertNoOpenTransfer).toHaveBeenLastCalledWith('gw-1', expect.any(Date), expect.anything());
	});
});
