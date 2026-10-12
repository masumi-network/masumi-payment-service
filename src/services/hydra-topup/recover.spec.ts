import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { HydraTopupStatus } from '@/generated/prisma/client';

type AsyncFn = (...args: unknown[]) => Promise<unknown>;
const mockFindUnique = jest.fn<AsyncFn>();
const mockUpdateMany = jest.fn<AsyncFn>();
const mockDelete = jest.fn<AsyncFn>();
const mockGetNode = jest.fn<(id: string) => unknown>();
const mockRecoverOnL1 = jest.fn<AsyncFn>();

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn() } }));
jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraTopup: { findUnique: mockFindUnique, updateMany: mockUpdateMany } },
}));
jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({ getNode: mockGetNode }),
}));
jest.unstable_mockModule('@/services/hydra-deposit-recovery/recover-on-l1', () => ({
	recoverDepositWithoutNode: mockRecoverOnL1,
}));

const { recoverHydraDeposit } = await import('./recover');

const topup = {
	id: 'topup-1',
	depositTxHash: 'ab'.repeat(32),
	status: HydraTopupStatus.Confirmed,
	hydraHeadId: 'head-1',
	HydraHead: { headIdentifier: 'cd'.repeat(28) },
	LocalParticipant: { walletId: 'hw-1' },
};

beforeEach(() => {
	jest.clearAllMocks();
	mockFindUnique.mockResolvedValue(topup);
	mockUpdateMany.mockResolvedValue({ count: 1 });
	mockGetNode.mockReturnValue({ delete: mockDelete });
	mockDelete.mockResolvedValue({});
	mockRecoverOnL1.mockResolvedValue({ recoverTxHash: 'ef'.repeat(32) });
});

describe('recoverHydraDeposit', () => {
	it('asks the live node and never posts on L1 itself', async () => {
		await expect(recoverHydraDeposit('topup-1')).resolves.toMatchObject({ requested: true, reason: null });
		expect(mockDelete).toHaveBeenCalledWith(`/commits/${topup.depositTxHash}`);
		expect(mockRecoverOnL1).not.toHaveBeenCalled();
	});

	it('posts the recover on L1 with the participant wallet when no node is live', async () => {
		mockGetNode.mockReturnValue(null);
		const result = await recoverHydraDeposit('topup-1');
		expect(mockRecoverOnL1).toHaveBeenCalledWith({
			hotWalletId: 'hw-1',
			depositTxHash: topup.depositTxHash,
			headIdentifier: 'cd'.repeat(28),
		});
		expect(result).toMatchObject({ requested: true, depositTxHash: topup.depositTxHash });
		expect(result.reason).toMatch(new RegExp('ef'.repeat(32)));
		expect(mockUpdateMany).toHaveBeenCalled();
	});

	it('does not post on L1 for a deposit the head absorbed', async () => {
		mockGetNode.mockReturnValue(null);
		mockFindUnique.mockResolvedValue({ ...topup, status: HydraTopupStatus.Absorbed });
		await expect(recoverHydraDeposit('topup-1')).resolves.toMatchObject({ requested: false });
		expect(mockRecoverOnL1).not.toHaveBeenCalled();
	});

	it('leaves a refused L1 recover unrecorded', async () => {
		mockGetNode.mockReturnValue(null);
		mockRecoverOnL1.mockRejectedValue(Object.assign(new Error('spent'), { status: 409 }));
		await expect(recoverHydraDeposit('topup-1')).rejects.toMatchObject({ status: 409 });
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});
});
