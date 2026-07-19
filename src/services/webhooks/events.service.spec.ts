import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { WebhookEventType } from '@/generated/prisma/client';

const mockQueueWebhookInTransaction = jest.fn() as jest.Mock<any>;

jest.unstable_mockModule('./queue.service', () => ({
	webhookQueueService: {
		queueWebhook: jest.fn(),
		queueWebhookInTransaction: mockQueueWebhookInTransaction,
	},
}));

jest.unstable_mockModule('@/utils/db', () => ({
	prisma: {
		paymentRequest: {
			findUnique: jest.fn(),
		},
		purchaseRequest: {
			findUnique: jest.fn(),
		},
	},
}));

jest.unstable_mockModule('@/utils/logger', () => ({
	logger: {
		info: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
		debug: jest.fn(),
	},
}));

jest.unstable_mockModule('@/utils/generator/blockchain-identifier-generator', () => ({
	decodeBlockchainIdentifier: jest.fn(() => null),
}));

const { webhookEventsService } = await import('./events.service');

describe('transactional error webhook events', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockQueueWebhookInTransaction.mockResolvedValue(undefined);
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
		const paymentRequestFindUnique = jest.fn() as jest.Mock<any>;
		paymentRequestFindUnique.mockResolvedValue(payment);
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

	it('rejects if the entity cannot be loaded, preserving outbox atomicity', async () => {
		const paymentRequestFindUnique = jest.fn() as jest.Mock<any>;
		paymentRequestFindUnique.mockResolvedValue(null);
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
