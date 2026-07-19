import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { WebhookEventType } from '@/generated/prisma/client';

const mockQueueWebhookInTransaction = jest.fn<
	(
		tx: object,
		eventType: WebhookEventType,
		payload: object,
		entityId?: string,
		paymentSourceId?: string,
	) => Promise<void>
>(async () => undefined);

jest.unstable_mockModule('./queue.service', () => ({
	webhookQueueService: {
		queueWebhook: jest.fn(),
		queueWebhookInTransaction: mockQueueWebhookInTransaction,
	},
}));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		paymentRequest: {
			findUnique: jest.fn(),
		},
		purchaseRequest: {
			findUnique: jest.fn(),
		},
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: {
		info: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
		debug: jest.fn(),
	},
}));

jest.unstable_mockModule('@masumi/payment-core/blockchain-identifier', () => ({
	decodeBlockchainIdentifier: jest.fn(() => null),
}));

const { webhookEventsService } = await import('./events.service');

describe('transactional error webhook events', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('loads the updated payment through the transaction and queues PAYMENT_ON_ERROR', async () => {
		const payment = {
			id: 'payment-1',
			blockchainIdentifier: 'blockchain-1',
			totalBuyerCardanoFees: 0n,
			totalSellerCardanoFees: 0n,
			submitResultTime: 1n,
			sellerCoolDownTime: 2n,
			buyerCoolDownTime: 3n,
			payByTime: 4n,
			unlockTime: 5n,
			externalDisputeUnlockTime: 6n,
			collateralReturnLovelace: 7n,
			RequestedFunds: [],
			WithdrawnForSeller: [],
			WithdrawnForBuyer: [],
			CurrentTransaction: null,
			TransactionHistory: [],
			PaymentSource: {
				id: 'payment-source-1',
			},
		};
		const paymentRequestFindUnique = jest.fn<(args: object) => Promise<typeof payment>>(async () => payment);
		const tx = {
			paymentRequest: {
				findUnique: paymentRequestFindUnique,
			},
		};

		await webhookEventsService.queuePaymentOnErrorInTransaction(tx as never, 'payment-1');

		expect(paymentRequestFindUnique).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: 'payment-1' },
			}),
		);
		expect(mockQueueWebhookInTransaction).toHaveBeenCalledWith(
			tx,
			WebhookEventType.PAYMENT_ON_ERROR,
			expect.objectContaining({
				id: 'payment-1',
				blockchainIdentifier: 'blockchain-1',
				collateralReturnLovelace: '7',
			}),
			'blockchain-1',
			'payment-source-1',
		);
	});

	it('rejects if the entity cannot be loaded so the state update also rolls back', async () => {
		const paymentRequestFindUnique = jest.fn<(args: object) => Promise<null>>(async () => null);
		const tx = {
			paymentRequest: {
				findUnique: paymentRequestFindUnique,
			},
		};

		await expect(webhookEventsService.queuePaymentOnErrorInTransaction(tx as never, 'missing')).rejects.toThrow(
			'Payment missing not found while queuing error webhook',
		);
		expect(mockQueueWebhookInTransaction).not.toHaveBeenCalled();
	});
});
