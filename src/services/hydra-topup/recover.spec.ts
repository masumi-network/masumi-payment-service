import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockTopupFindUnique = jest.fn() as AnyMock;
const mockTopupUpdateMany = jest.fn() as AnyMock;
const mockAssertNotPaused = jest.fn() as AnyMock;
const mockAssertNotStopping = jest.fn() as AnyMock;
const mockNodeDelete = jest.fn() as AnyMock;
const mockGetNode = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraTopup: { findUnique: mockTopupFindUnique, updateMany: mockTopupUpdateMany } },
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({ getNode: mockGetNode }),
}));
jest.unstable_mockModule('@/services/hydra-host/pause', () => ({
	assertHydraHeadHostNotPaused: mockAssertNotPaused,
	assertHydraHeadHostNotStopping: mockAssertNotStopping,
}));

let recoverHydraDeposit: typeof import('./recover').recoverHydraDeposit;

beforeAll(async () => {
	({ recoverHydraDeposit } = await import('./recover'));
});

beforeEach(() => {
	jest.clearAllMocks();
	mockTopupFindUnique.mockResolvedValue({
		id: 'topup-1',
		depositTxHash: 'aa'.repeat(32),
		status: 'Failed',
		hydraHeadId: 'head-1',
	});
	mockTopupUpdateMany.mockResolvedValue({ count: 1 });
	mockAssertNotPaused.mockResolvedValue(undefined);
	mockAssertNotStopping.mockResolvedValue(undefined);
	mockGetNode.mockReturnValue({ delete: mockNodeDelete });
	mockNodeDelete.mockResolvedValue(undefined);
});

describe('recoverHydraDeposit', () => {
	it('asks the node to recover a settled deposit', async () => {
		await expect(recoverHydraDeposit('topup-1')).resolves.toMatchObject({ requested: true });
		expect(mockNodeDelete).toHaveBeenCalledWith(`/commits/${'aa'.repeat(32)}`);
	});

	// A recovery is a new L1 transaction from the node.
	it('refuses while the head is on a paused host, before it asks the node', async () => {
		mockAssertNotPaused.mockRejectedValue(Object.assign(new Error('paused'), { status: 409 }));

		await expect(recoverHydraDeposit('topup-1')).rejects.toMatchObject({ status: 409 });
		expect(mockAssertNotPaused).toHaveBeenCalledWith('head-1');
		expect(mockNodeDelete).not.toHaveBeenCalled();
		expect(mockTopupUpdateMany).not.toHaveBeenCalled();
	});

	// A pause waits for a Confirmed deposit, and only a recovery can end one the
	// head never absorbs.
	it('still recovers a Confirmed deposit while the pause drains', async () => {
		mockTopupFindUnique.mockResolvedValue({
			id: 'topup-1',
			depositTxHash: 'aa'.repeat(32),
			status: 'Confirmed',
			hydraHeadId: 'head-1',
		});
		mockAssertNotPaused.mockRejectedValue(Object.assign(new Error('paused'), { status: 409 }));

		await expect(recoverHydraDeposit('topup-1')).resolves.toMatchObject({ requested: true });
		expect(mockNodeDelete).toHaveBeenCalled();
	});

	// Once the nodes are stopped, an unanswered request would read as posted.
	it('refuses a Confirmed deposit once the pause has stopped the nodes', async () => {
		mockTopupFindUnique.mockResolvedValue({
			id: 'topup-1',
			depositTxHash: 'aa'.repeat(32),
			status: 'Confirmed',
			hydraHeadId: 'head-1',
		});
		mockAssertNotStopping.mockRejectedValue(Object.assign(new Error('stopped'), { status: 409 }));

		await expect(recoverHydraDeposit('topup-1')).rejects.toMatchObject({ status: 409 });
		expect(mockAssertNotStopping).toHaveBeenCalledWith('head-1');
		expect(mockNodeDelete).not.toHaveBeenCalled();
		expect(mockTopupUpdateMany).not.toHaveBeenCalled();
	});
});
