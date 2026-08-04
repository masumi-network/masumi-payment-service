import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { TransactionLayer, TransactionStatus } from '@/generated/prisma/client';

type AnyMock = jest.Mock<(...args: any[]) => any>;

const mockFindUnique = jest.fn() as AnyMock;
const mockTransactionUpdate = jest.fn() as AnyMock;
const mockHotWalletUpdateMany = jest.fn() as AnyMock;
const mockPurchaseUpdate = jest.fn() as AnyMock;

const tx = {
	transaction: { findUnique: mockFindUnique, update: mockTransactionUpdate },
	hotWallet: { updateMany: mockHotWalletUpdateMany },
	purchaseRequest: { update: mockPurchaseUpdate },
};

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		$transaction: (callback: (client: unknown) => unknown) => callback(tx),
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@/services/shared', () => ({
	connectPreviousAction: () => ({}),
	createNextPurchaseAction: () => ({}),
}));

const { releaseRejectedL2Reservation } = await import('./l2-reservation-release');

const reservation = {
	id: 'tx-1',
	l2ReservationPreviousLayer: TransactionLayer.L1,
	l2ReservationPreviousSmartContractWalletId: null,
	l2ReservationPreviousBuyerReturnAddress: 'addr_test1previous',
	l2ReservationPreviousCollateralReturn: 5_000_000n,
};

function pendingRejected(overrides: Record<string, unknown> = {}) {
	return {
		status: TransactionStatus.Pending,
		txHash: null,
		l2RejectedByHeadAt: new Date(),
		PurchaseRequestCurrent: [{ id: 'purchase-1', nextActionId: 'action-1' }],
		...overrides,
	};
}

beforeEach(() => {
	jest.clearAllMocks();
	mockFindUnique.mockResolvedValue(pendingRejected());
	mockTransactionUpdate.mockResolvedValue({});
	mockHotWalletUpdateMany.mockResolvedValue({ count: 1 });
	mockPurchaseUpdate.mockResolvedValue({});
});

/**
 * The reservation exists so an accepted-but-unreported lock can never be retried
 * from different inputs. Releasing it is safe only once the head has refused the
 * body and the body can no longer be included by anyone.
 */
describe('releaseRejectedL2Reservation', () => {
	it('rolls the transaction back, frees the wallet and returns the request', async () => {
		await expect(releaseRejectedL2Reservation(reservation)).resolves.toBe(true);

		expect(mockTransactionUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: TransactionStatus.RolledBack }) }),
		);
		// Scoped to this reservation, so a wallet claimed by later work is untouched.
		expect(mockHotWalletUpdateMany).toHaveBeenCalledWith({
			where: { pendingTransactionId: 'tx-1' },
			data: { lockedAt: null, pendingTransactionId: null },
		});
		expect(mockPurchaseUpdate).toHaveBeenCalledTimes(1);
	});

	// A confirmation arriving between the gate and this write must win: the funds
	// are locked, and handing the request back would authorise a second lock.
	it('does nothing once the transaction has a hash', async () => {
		mockFindUnique.mockResolvedValue(pendingRejected({ txHash: 'a'.repeat(64) }));

		await expect(releaseRejectedL2Reservation(reservation)).resolves.toBe(false);
		expect(mockTransactionUpdate).not.toHaveBeenCalled();
		expect(mockHotWalletUpdateMany).not.toHaveBeenCalled();
	});

	it('does nothing when the head never refused the body', async () => {
		mockFindUnique.mockResolvedValue(pendingRejected({ l2RejectedByHeadAt: null }));

		await expect(releaseRejectedL2Reservation(reservation)).resolves.toBe(false);
		expect(mockTransactionUpdate).not.toHaveBeenCalled();
	});

	it('does nothing when the reservation is no longer pending', async () => {
		mockFindUnique.mockResolvedValue(pendingRejected({ status: TransactionStatus.Confirmed }));

		await expect(releaseRejectedL2Reservation(reservation)).resolves.toBe(false);
		expect(mockTransactionUpdate).not.toHaveBeenCalled();
	});

	it('restores the wallet the reservation replaced', async () => {
		await releaseRejectedL2Reservation({
			...reservation,
			l2ReservationPreviousSmartContractWalletId: 'wallet-before',
		});

		expect(mockPurchaseUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					SmartContractWallet: { connect: { id: 'wallet-before' } },
					CurrentTransaction: { disconnect: true },
				}),
			}),
		);
	});
});
