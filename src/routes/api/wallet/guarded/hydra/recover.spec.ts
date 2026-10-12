import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { GuardedHydraTransferDirection, GuardedHydraTransferStatus } from '@/generated/prisma/client';
import { HydraTransportAmbiguousError } from '@/lib/hydra/hydra/errors';

type AsyncFn = (...args: unknown[]) => Promise<unknown>;
const mockFindUnique = jest.fn<AsyncFn>();
const mockFindInHead = jest.fn<AsyncFn>();
const mockDelete = jest.fn<AsyncFn>();
const mockGetNode = jest.fn<(id: string) => unknown>();

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn() } }));
jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { guardedHydraTransfer: { findUnique: mockFindUnique } },
}));
jest.unstable_mockModule('./transfers', () => ({
	loadGuardedHotWallet: () => Promise.resolve({ guarded: { policyId: 'p', stateTokenName: 't' } }),
	transferView: (transfer: unknown) => transfer,
}));
jest.unstable_mockModule('./location', () => ({ findGuardedWalletInHead: mockFindInHead }));
jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({ getNode: mockGetNode }),
}));

const { recoverGuardedDeposit } = await import('./recover');

const scope = { networkLimit: [], walletScopeIds: null } as never;
const deposit = {
	id: 'tr-1',
	direction: GuardedHydraTransferDirection.Deposit,
	status: GuardedHydraTransferStatus.Submitted,
	hydraHeadId: 'head-1',
	txHash: 'ab'.repeat(32),
	recoverableAt: new Date(Date.now() - 60_000),
	GuardedWallet: { hotWalletId: 'hw-1' },
};

beforeEach(() => {
	jest.clearAllMocks();
	mockFindUnique.mockResolvedValue(deposit);
	mockFindInHead.mockResolvedValue(null);
	mockGetNode.mockReturnValue({ delete: mockDelete });
	mockDelete.mockResolvedValue({});
});

describe('recoverGuardedDeposit', () => {
	it('asks the node to recover the deposit by its L1 transaction id', async () => {
		await expect(recoverGuardedDeposit({ transferId: 'tr-1' }, scope)).resolves.toEqual({
			transfer: deposit,
			reason: null,
		});
		expect(mockDelete).toHaveBeenCalledWith(`/commits/${deposit.txHash}`);
	});

	it('refuses before the deposit deadline', async () => {
		mockFindUnique.mockResolvedValue({ ...deposit, recoverableAt: new Date(Date.now() + 60_000) });
		await expect(recoverGuardedDeposit({ transferId: 'tr-1' }, scope)).rejects.toMatchObject({ status: 409 });
		expect(mockDelete).not.toHaveBeenCalled();
	});

	it('refuses a deposit that is not Submitted', async () => {
		mockFindUnique.mockResolvedValue({ ...deposit, status: GuardedHydraTransferStatus.Confirmed });
		await expect(recoverGuardedDeposit({ transferId: 'tr-1' }, scope)).rejects.toMatchObject({ status: 409 });
		expect(mockDelete).not.toHaveBeenCalled();
	});

	it('does not treat a withdraw as a deposit', async () => {
		mockFindUnique.mockResolvedValue({ ...deposit, direction: GuardedHydraTransferDirection.Withdraw });
		await expect(recoverGuardedDeposit({ transferId: 'tr-1' }, scope)).rejects.toMatchObject({ status: 404 });
	});

	it('refuses when the head already holds the wallet', async () => {
		mockFindInHead.mockResolvedValue({ hydraHeadId: 'head-1' });
		await expect(recoverGuardedDeposit({ transferId: 'tr-1' }, scope)).rejects.toMatchObject({ status: 409 });
		expect(mockDelete).not.toHaveBeenCalled();
	});

	it('reports a lost node answer instead of failing', async () => {
		mockDelete.mockRejectedValue(new HydraTransportAmbiguousError('timeout'));
		const result = await recoverGuardedDeposit({ transferId: 'tr-1' }, scope);
		expect(result.reason).toMatch(/did not answer/);
	});

	it('maps a node refusal to 409', async () => {
		mockDelete.mockRejectedValue(new Error('DepositNotRecoverable'));
		await expect(recoverGuardedDeposit({ transferId: 'tr-1' }, scope)).rejects.toMatchObject({ status: 409 });
	});
});
