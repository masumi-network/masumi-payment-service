import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PaymentAction, PurchasingAction } from '@/generated/prisma/client';

const mockQueuePaymentOnError = jest.fn<(tx: object, requestId: string) => Promise<void>>(async () => undefined);
const mockQueuePurchaseOnError = jest.fn<(tx: object, requestId: string) => Promise<void>>(async () => undefined);

jest.unstable_mockModule('@/services/webhooks/events.service', () => ({
	webhookEventsService: {
		queuePaymentOnErrorInTransaction: mockQueuePaymentOnError,
		queuePurchaseOnErrorInTransaction: mockQueuePurchaseOnError,
	},
}));

const { writePaymentErrorTransition, writePurchaseErrorTransition } = await import('./error-transition');

describe('transactional error transitions', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('updates a payment and queues PAYMENT_ON_ERROR on the same transaction', async () => {
		const paymentRequestUpdate = jest.fn<(args: { where: { id: string }; data: object }) => Promise<{ id: string }>>(
			async () => ({ id: 'payment-1' }),
		);
		const tx = {
			paymentRequest: {
				update: paymentRequestUpdate,
			},
		};

		await writePaymentErrorTransition(tx as never, {
			requestId: 'payment-1',
			nextActionId: 'action-1',
			errorNote: 'Collecting payments failed',
			resultHash: 'result-hash',
		});

		expect(paymentRequestUpdate).toHaveBeenCalledWith({
			where: { id: 'payment-1' },
			data: expect.objectContaining({
				ActionHistory: { connect: { id: 'action-1' } },
				NextAction: {
					create: expect.objectContaining({
						requestedAction: PaymentAction.WaitingForManualAction,
						errorNote: 'Collecting payments failed',
						resultHash: 'result-hash',
					}),
				},
				SmartContractWallet: { update: { lockedAt: null } },
			}),
		});
		expect(mockQueuePaymentOnError).toHaveBeenCalledWith(tx, 'payment-1');
	});

	it('updates a purchase and queues PURCHASE_ON_ERROR on the same transaction', async () => {
		const purchaseRequestUpdate = jest.fn<(args: { where: { id: string }; data: object }) => Promise<{ id: string }>>(
			async () => ({ id: 'purchase-1' }),
		);
		const tx = {
			purchaseRequest: {
				update: purchaseRequestUpdate,
			},
		};

		await writePurchaseErrorTransition(tx as never, {
			requestId: 'purchase-1',
			nextActionId: 'action-2',
			errorNote: 'Collecting refund failed',
			unlockWallet: false,
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
			}),
		});
		expect(purchaseRequestUpdate.mock.calls[0]?.[0].data).not.toHaveProperty('SmartContractWallet');
		expect(mockQueuePurchaseOnError).toHaveBeenCalledWith(tx, 'purchase-1');
	});
});
