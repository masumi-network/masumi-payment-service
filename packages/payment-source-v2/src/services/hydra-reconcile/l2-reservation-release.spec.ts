import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PaymentAction, PurchasingAction, TransactionLayer, TransactionStatus } from '@/generated/prisma/client';

type AnyMock = jest.Mock<(...args: any[]) => any>;

const mockFindUnique = jest.fn() as AnyMock;
const mockTransactionUpdate = jest.fn() as AnyMock;
const mockHotWalletUpdateMany = jest.fn() as AnyMock;
const mockPurchaseUpdate = jest.fn() as AnyMock;
const mockPaymentUpdate = jest.fn() as AnyMock;

const tx = {
	transaction: { findUnique: mockFindUnique, update: mockTransactionUpdate },
	hotWallet: { updateMany: mockHotWalletUpdateMany },
	purchaseRequest: { update: mockPurchaseUpdate },
	paymentRequest: { update: mockPaymentUpdate },
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
	createNextPurchaseAction: (requestedAction: string, data: object = {}) => ({
		NextAction: { create: { requestedAction, ...data } },
	}),
	createNextPaymentAction: (requestedAction: string, data: object = {}) => ({
		NextAction: { create: { requestedAction, ...data } },
	}),
}));

const { releaseRejectedL2Reservation } = await import('./l2-reservation-release');
const { prisma } = await import('@masumi/payment-core/db');

const reservation = {
	id: 'tx-1',
	l2ReservationPreviousLayer: TransactionLayer.L1,
	l2ReservationPreviousSmartContractWalletId: null,
	l2ReservationPreviousBuyerReturnAddress: 'addr_test1previous',
	l2ReservationPreviousCollateralReturn: 5_000_000n,
	// An initial lock reserves a request with no current transaction.
	l2ReservationPreviousTransactionId: null,
};
const actionReservation = { ...reservation, l2ReservationPreviousTransactionId: 'previous-tx' };

const lockingPurchase = {
	id: 'purchase-1',
	nextActionId: 'action-1',
	NextAction: { requestedAction: PurchasingAction.FundsLockingInitiated },
};

function pendingRejected(overrides: Record<string, unknown> = {}) {
	return {
		status: TransactionStatus.Pending,
		txHash: null,
		l2RejectedByHeadAt: new Date(),
		PurchaseRequestCurrent: [lockingPurchase],
		PaymentRequestCurrent: [],
		...overrides,
	};
}

beforeEach(() => {
	jest.clearAllMocks();
	mockFindUnique.mockResolvedValue(pendingRejected());
	mockTransactionUpdate.mockResolvedValue({});
	mockHotWalletUpdateMany.mockResolvedValue({ count: 1 });
	mockPurchaseUpdate.mockResolvedValue({});
	mockPaymentUpdate.mockResolvedValue({});
});

/**
 * The reservation exists so an accepted-but-unreported lock can never be retried
 * from different inputs. Releasing it is safe only once the head has refused the
 * body and the body can no longer be included by anyone.
 */
describe('releaseRejectedL2Reservation', () => {
	it('rolls the transaction back, frees the wallet and returns the request', async () => {
		await expect(releaseRejectedL2Reservation(reservation, prisma as never, 'head-rejection')).resolves.toBe(true);

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

		await expect(releaseRejectedL2Reservation(reservation, prisma as never, 'head-rejection')).resolves.toBe(false);
		expect(mockTransactionUpdate).not.toHaveBeenCalled();
		expect(mockHotWalletUpdateMany).not.toHaveBeenCalled();
	});

	it('does nothing when the head never refused the body', async () => {
		mockFindUnique.mockResolvedValue(pendingRejected({ l2RejectedByHeadAt: null }));

		await expect(releaseRejectedL2Reservation(reservation, prisma as never, 'head-rejection')).resolves.toBe(false);
		expect(mockTransactionUpdate).not.toHaveBeenCalled();
	});

	// Automatic recovery proves the body dead from its inputs, not from a head
	// rejection, so that proof mode must not require one.
	it('releases without a head rejection under the input proof', async () => {
		mockFindUnique.mockResolvedValue(pendingRejected({ l2RejectedByHeadAt: null }));

		await expect(releaseRejectedL2Reservation(reservation, prisma as never, 'spent-by-release-nudge')).resolves.toBe(
			true,
		);
		expect(mockHotWalletUpdateMany).toHaveBeenCalledTimes(1);
		// The marker that lets a late confirmation of this body halt replay.
		expect(mockTransactionUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ l2ReleasedByInputProofAt: expect.any(Date) }) }),
		);
	});

	// An admin release has no proof, so it is marked apart from one, and the
	// same late-confirmation halt applies.
	it('marks an operator release apart from a proven one', async () => {
		mockFindUnique.mockResolvedValue(pendingRejected({ l2RejectedByHeadAt: null }));

		await expect(releaseRejectedL2Reservation(reservation, prisma as never, 'operator')).resolves.toBe(true);
		const data = mockTransactionUpdate.mock.calls[0]?.[0]?.data as Record<string, unknown>;
		expect(data.l2ReleasedByOperatorAt).toEqual(expect.any(Date));
		expect(data).not.toHaveProperty('l2ReleasedByInputProofAt');
	});

	it('refuses when a nudge was recorded after the release decision read the row', async () => {
		mockFindUnique.mockResolvedValue(
			pendingRejected({ l2RejectedByHeadAt: null, l2ReleaseNudgeTx: 'other-nudge-cbor' }),
		);

		await expect(
			releaseRejectedL2Reservation(
				{ ...reservation, l2ReleaseNudgeTx: null },
				prisma as never,
				'spent-by-release-nudge',
			),
		).resolves.toBe(false);
		expect(mockHotWalletUpdateMany).not.toHaveBeenCalled();
	});

	// TxValid may already have paired the seller's PaymentRequest, which a
	// release does not undo.
	it('still refuses a TxValid (hashed) transaction under the input proof', async () => {
		mockFindUnique.mockResolvedValue(
			pendingRejected({ l2RejectedByHeadAt: null, txHash: 'a'.repeat(64), intendedTxHash: 'a'.repeat(64) }),
		);

		await expect(releaseRejectedL2Reservation(reservation, prisma as never, 'spent-by-release-nudge')).resolves.toBe(
			false,
		);
		expect(mockTransactionUpdate).not.toHaveBeenCalled();
	});

	it('does nothing when the reservation is no longer pending', async () => {
		mockFindUnique.mockResolvedValue(pendingRejected({ status: TransactionStatus.Confirmed }));

		await expect(releaseRejectedL2Reservation(reservation, prisma as never, 'head-rejection')).resolves.toBe(false);
		expect(mockTransactionUpdate).not.toHaveBeenCalled();
	});

	it('restores the wallet the reservation replaced', async () => {
		await releaseRejectedL2Reservation(
			{ ...reservation, l2ReservationPreviousSmartContractWalletId: 'wallet-before' },
			prisma as never,
			'head-rejection',
		);

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

/**
 * The six non-locking L2 actions (submit-result, collection, refunds,
 * withdrawal) reserve through the same row shape. Before this, a release put
 * every request back to FundsLockingRequested, so these rows could never be
 * released at all and pinned their wallet for good.
 */
describe('releaseRejectedL2Reservation for a non-locking action', () => {
	it('returns a seller request to its retry action and the transaction it replaced', async () => {
		mockFindUnique.mockResolvedValue(
			pendingRejected({
				l2RejectedByHeadAt: null,
				PurchaseRequestCurrent: [],
				PaymentRequestCurrent: [
					{
						id: 'payment-1',
						nextActionId: 'action-2',
						NextAction: { requestedAction: PaymentAction.SubmitResultInitiated, resultHash: 'result-hash' },
					},
				],
			}),
		);

		await expect(
			releaseRejectedL2Reservation(actionReservation, prisma as never, 'spent-by-release-nudge'),
		).resolves.toBe(true);

		expect(mockPaymentUpdate).toHaveBeenCalledWith({
			where: { id: 'payment-1', nextActionId: 'action-2', currentTransactionId: 'tx-1', layer: TransactionLayer.L2 },
			data: {
				NextAction: { create: { requestedAction: PaymentAction.SubmitResultRequested, resultHash: 'result-hash' } },
				CurrentTransaction: { connect: { id: 'previous-tx' } },
				TransactionHistory: { disconnect: { id: 'previous-tx' }, connect: { id: 'tx-1' } },
			},
		});
		expect(mockPurchaseUpdate).not.toHaveBeenCalled();
		expect(mockHotWalletUpdateMany).toHaveBeenCalledWith({
			where: { pendingTransactionId: 'tx-1' },
			data: { lockedAt: null, pendingTransactionId: null },
		});
	});

	it('returns a buyer request to its retry action, not to funds locking', async () => {
		mockFindUnique.mockResolvedValue(
			pendingRejected({
				l2RejectedByHeadAt: null,
				PurchaseRequestCurrent: [
					{
						id: 'purchase-2',
						nextActionId: 'action-3',
						NextAction: { requestedAction: PurchasingAction.WithdrawRefundInitiated },
					},
				],
			}),
		);

		await expect(
			releaseRejectedL2Reservation(actionReservation, prisma as never, 'spent-by-release-nudge'),
		).resolves.toBe(true);

		expect(mockPurchaseUpdate).toHaveBeenCalledWith({
			where: { id: 'purchase-2', nextActionId: 'action-3', currentTransactionId: 'tx-1', layer: TransactionLayer.L2 },
			data: {
				NextAction: { create: { requestedAction: PurchasingAction.WithdrawRefundRequested } },
				CurrentTransaction: { connect: { id: 'previous-tx' } },
				TransactionHistory: { disconnect: { id: 'previous-tx' }, connect: { id: 'tx-1' } },
			},
		});
	});

	// An action this helper does not know how to undo is left for an operator.
	it('holds a seller request in an action it cannot map back', async () => {
		mockFindUnique.mockResolvedValue(
			pendingRejected({
				l2RejectedByHeadAt: null,
				PurchaseRequestCurrent: [],
				PaymentRequestCurrent: [
					{ id: 'payment-1', nextActionId: 'action-2', NextAction: { requestedAction: PaymentAction.None } },
				],
			}),
		);

		await expect(
			releaseRejectedL2Reservation(actionReservation, prisma as never, 'spent-by-release-nudge'),
		).resolves.toBe(false);
		expect(mockTransactionUpdate).not.toHaveBeenCalled();
		expect(mockHotWalletUpdateMany).not.toHaveBeenCalled();
	});

	it('holds a reservation that carries both an initial lock and an action', async () => {
		mockFindUnique.mockResolvedValue(
			pendingRejected({
				l2RejectedByHeadAt: null,
				PurchaseRequestCurrent: [
					lockingPurchase,
					{
						id: 'purchase-2',
						nextActionId: 'action-3',
						NextAction: { requestedAction: PurchasingAction.WithdrawRefundInitiated },
					},
				],
			}),
		);

		await expect(
			releaseRejectedL2Reservation(actionReservation, prisma as never, 'spent-by-release-nudge'),
		).resolves.toBe(false);
		expect(mockTransactionUpdate).not.toHaveBeenCalled();
		expect(mockPurchaseUpdate).not.toHaveBeenCalled();
	});

	it('holds an action reservation that does not record the transaction it replaced', async () => {
		mockFindUnique.mockResolvedValue(
			pendingRejected({
				l2RejectedByHeadAt: null,
				PurchaseRequestCurrent: [],
				PaymentRequestCurrent: [
					{
						id: 'payment-1',
						nextActionId: 'action-2',
						NextAction: { requestedAction: PaymentAction.WithdrawInitiated },
					},
				],
			}),
		);

		await expect(releaseRejectedL2Reservation(reservation, prisma as never, 'spent-by-release-nudge')).resolves.toBe(
			false,
		);
		expect(mockTransactionUpdate).not.toHaveBeenCalled();
	});

	// The request's action today must not turn an action back into a lock: a
	// lock restore would disconnect the wallet and re-lock a funded escrow.
	it('holds an action reservation whose buyer request left the action it reserved', async () => {
		mockFindUnique.mockResolvedValue(
			pendingRejected({
				l2RejectedByHeadAt: null,
				PurchaseRequestCurrent: [
					{
						id: 'purchase-2',
						nextActionId: 'action-3',
						NextAction: { requestedAction: PurchasingAction.WaitingForManualAction },
					},
				],
			}),
		);

		await expect(
			releaseRejectedL2Reservation(actionReservation, prisma as never, 'spent-by-release-nudge'),
		).resolves.toBe(false);
		expect(mockTransactionUpdate).not.toHaveBeenCalled();
		expect(mockPurchaseUpdate).not.toHaveBeenCalled();
	});
});
