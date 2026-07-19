import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PaymentAction, PurchasingAction } from '@/generated/prisma/client';

const mockQueuePaymentOnError = jest.fn() as jest.Mock<any>;
const mockQueuePurchaseOnError = jest.fn() as jest.Mock<any>;

jest.unstable_mockModule('@/services/webhooks/events.service', () => ({
	webhookEventsService: {
		queuePaymentOnErrorInTransaction: mockQueuePaymentOnError,
		queuePurchaseOnErrorInTransaction: mockQueuePurchaseOnError,
	},
}));

const { writePaymentErrorTransition, writePurchaseErrorTransition } = await import('./error-transition');

describe('error transition webhook outbox', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockQueuePaymentOnError.mockResolvedValue(undefined);
		mockQueuePurchaseOnError.mockResolvedValue(undefined);
	});

	it('updates a payment error and queues PAYMENT_ON_ERROR in the same transaction', async () => {
		const paymentRequestUpdate = jest.fn() as jest.Mock<any>;
		paymentRequestUpdate.mockResolvedValue({ id: 'payment-1' });
		const tx = {
			paymentRequest: {
				update: paymentRequestUpdate,
			},
		};

		await writePaymentErrorTransition(tx as never, {
			requestId: 'payment-1',
			nextActionId: 'action-1',
			errorNote: 'Collecting payments failed',
		});

		expect(paymentRequestUpdate).toHaveBeenCalledWith({
			where: { id: 'payment-1' },
			data: expect.objectContaining({
				ActionHistory: { connect: { id: 'action-1' } },
				NextAction: {
					create: expect.objectContaining({
						requestedAction: PaymentAction.WaitingForManualAction,
						errorNote: 'Collecting payments failed',
					}),
				},
				SmartContractWallet: { update: { lockedAt: null } },
			}),
		});
		expect(mockQueuePaymentOnError).toHaveBeenCalledWith(tx, 'payment-1');
	});

	it('updates a purchase error and queues PURCHASE_ON_ERROR in the same transaction', async () => {
		const purchaseRequestUpdate = jest.fn() as jest.Mock<any>;
		purchaseRequestUpdate.mockResolvedValue({ id: 'purchase-1' });
		const tx = {
			purchaseRequest: {
				update: purchaseRequestUpdate,
			},
		};

		await writePurchaseErrorTransition(tx as never, {
			requestId: 'purchase-1',
			nextActionId: 'action-2',
			errorNote: 'Collecting refund failed',
		});

		expect(purchaseRequestUpdate).toHaveBeenCalledWith({
			where: { id: 'purchase-1' },
			data: expect.objectContaining({
				ActionHistory: { connect: { id: 'action-2' } },
				NextAction: {
					create: expect.objectContaining({
						requestedAction: PurchasingAction.WaitingForManualAction,
						errorNote: 'Collecting refund failed',
					}),
				},
				SmartContractWallet: { update: { lockedAt: null } },
			}),
		});
		expect(mockQueuePurchaseOnError).toHaveBeenCalledWith(tx, 'purchase-1');
	});
});
