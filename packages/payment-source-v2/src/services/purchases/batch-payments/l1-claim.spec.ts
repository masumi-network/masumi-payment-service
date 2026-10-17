import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Prisma, PurchasingAction, TransactionLayer } from '@/generated/prisma/client';

type AnyMock = jest.Mock<(...args: any[]) => any>;

const mockUpdate = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { purchaseRequest: { update: mockUpdate } },
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { claimSelectedL1Request, L1PurchaseClaimLostError, revertOwnedL1BatchRequests, selectedL1RequestWhere } =
	await import('./l1-claim');

const selected = {
	id: 'req-1',
	nextActionId: 'action-requested',
	forceLayer: null,
	paymentForceLayer: TransactionLayer.L1,
};

function recordNotFound() {
	return new Prisma.PrismaClientKnownRequestError('No record was found for an update.', {
		code: 'P2025',
		clientVersion: 'test',
	});
}

beforeEach(() => {
	jest.clearAllMocks();
});

describe('L1 pre-submit claim', () => {
	it('matches only the state the L1 batch selected', () => {
		expect(selectedL1RequestWhere(selected)).toEqual({
			id: 'req-1',
			nextActionId: 'action-requested',
			currentTransactionId: null,
			onChainState: null,
			forceLayer: null,
			paymentForceLayer: TransactionLayer.L1,
		});
	});

	// The race: another replica claims the request on L2 after L1 selected it.
	// The guarded write no longer matches, and L1 must abort, not overwrite.
	it('throws a claim-lost error when another writer took the request', async () => {
		const tx = { purchaseRequest: { update: jest.fn() as AnyMock } };
		tx.purchaseRequest.update.mockRejectedValue(recordNotFound());

		await expect(
			claimSelectedL1Request(tx as unknown as Prisma.TransactionClient, selected, {}),
		).rejects.toBeInstanceOf(L1PurchaseClaimLostError);
		expect(tx.purchaseRequest.update).toHaveBeenCalledWith(
			expect.objectContaining({ where: selectedL1RequestWhere(selected) }),
		);
	});

	it('passes other errors through unchanged', async () => {
		const tx = { purchaseRequest: { update: jest.fn() as AnyMock } };
		const error = new Error('connection lost');
		tx.purchaseRequest.update.mockRejectedValue(error);

		await expect(claimSelectedL1Request(tx as unknown as Prisma.TransactionClient, selected, {})).rejects.toBe(error);
	});
});

describe('L1 batch revert', () => {
	it('writes only to requests that still point at the L1 shared transaction', async () => {
		mockUpdate.mockResolvedValueOnce({ id: 'req-1' }).mockRejectedValueOnce(recordNotFound());

		await revertOwnedL1BatchRequests({
			sharedTxId: 'l1-shared-tx',
			requests: [
				{ id: 'req-1', nextActionId: 'a-1' },
				{ id: 'req-l2', nextActionId: 'a-2' },
			],
			isRetryable: true,
			errorNote: 'unused',
		});

		expect(mockUpdate).toHaveBeenCalledTimes(2);
		for (const call of mockUpdate.mock.calls) {
			expect(call[0]).toMatchObject({ where: { currentTransactionId: 'l1-shared-tx' } });
		}
		expect(mockUpdate.mock.calls[0][0]).toMatchObject({
			data: { NextAction: { create: { requestedAction: PurchasingAction.FundsLockingRequested } } },
		});
	});

	it('changes nothing when the batch has no shared transaction', async () => {
		await revertOwnedL1BatchRequests({
			sharedTxId: null,
			requests: [{ id: 'req-1', nextActionId: 'a-1' }],
			isRetryable: false,
			errorNote: 'failed',
		});

		expect(mockUpdate).not.toHaveBeenCalled();
	});

	it('rethrows errors other than a lost ownership match', async () => {
		const error = new Error('connection lost');
		mockUpdate.mockRejectedValueOnce(error);

		await expect(
			revertOwnedL1BatchRequests({
				sharedTxId: 'l1-shared-tx',
				requests: [{ id: 'req-1', nextActionId: 'a-1' }],
				isRetryable: false,
				errorNote: 'failed',
			}),
		).rejects.toBe(error);
	});
});
