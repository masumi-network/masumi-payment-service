import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { TransactionStatus } from '@/generated/prisma/client';

type AnyMock = jest.Mock<(...args: any[]) => any>;

const mockTransactionFindFirst = jest.fn() as AnyMock;
const mockHydraHeadFindUnique = jest.fn() as AnyMock;
const mockLoggerError = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		transaction: { findFirst: mockTransactionFindFirst, findUnique: jest.fn() },
		hydraHead: { findUnique: mockHydraHeadFindUnique },
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: mockLoggerError, debug: jest.fn() },
}));

const { applyConfirmedHydraTransaction } = await import('./head-tx-confirmed');

const host = {
	getProvider: () => null,
	getNode: () => null,
	flushHeadStatus: async () => {},
	isStatusQuarantined: () => false,
};

beforeEach(() => {
	jest.clearAllMocks();
	// The head lookup in datum sync: absent, so sync itself returns 'retry'.
	mockHydraHeadFindUnique.mockResolvedValue(null);
});

describe('applyConfirmedHydraTransaction after an auto-release', () => {
	it('holds replay and alerts when an auto-released body confirms', async () => {
		mockTransactionFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'released-1' });

		await expect(applyConfirmedHydraTransaction(host, 'head-1', 'a'.repeat(64))).resolves.toBe('retry');
		expect(mockTransactionFindFirst.mock.calls[1]?.[0]).toEqual(
			expect.objectContaining({
				where: expect.objectContaining({
					status: TransactionStatus.RolledBack,
					l2ReleasedByInputProofAt: { not: null },
				}),
			}),
		);
		expect(mockLoggerError).toHaveBeenCalledTimes(1);
		// Datum sync never ran against the request's new state.
		expect(mockHydraHeadFindUnique).not.toHaveBeenCalled();
	});

	it('falls through to datum sync when no released row matches', async () => {
		mockTransactionFindFirst.mockResolvedValue(null);

		await applyConfirmedHydraTransaction(host, 'head-1', 'a'.repeat(64));
		expect(mockLoggerError).not.toHaveBeenCalled();
		expect(mockHydraHeadFindUnique).toHaveBeenCalledTimes(1);
	});
});
