import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { WebhookDeliveryStatus, WebhookEventType } from '@/generated/prisma/client';

const mockWebhookEndpointFindMany = jest.fn() as jest.Mock<any>;
const mockWebhookDeliveryCreate = jest.fn() as jest.Mock<any>;

jest.unstable_mockModule('@/utils/config', () => ({
	CONFIG: {
		OTEL_SERVICE_NAME: 'masumi-test-service',
	},
}));

jest.unstable_mockModule('@/utils/db', () => ({
	prisma: {
		webhookEndpoint: {
			findMany: jest.fn(),
		},
		webhookDelivery: {
			create: jest.fn(),
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

jest.unstable_mockModule('./sender.service', () => ({
	webhookSenderService: {
		processWebhookDelivery: jest.fn(),
	},
}));

const { webhookQueueService } = await import('./queue.service');

const lowBalancePayload = {
	ruleId: 'rule-1',
	walletId: 'wallet-1',
	walletAddress: 'addr_test1...',
	walletVkey: 'wallet-vkey',
	walletType: 'Selling' as const,
	paymentSourceId: 'payment-source-1',
	network: 'Preprod' as const,
	assetUnit: 'lovelace',
	thresholdAmount: '1000000',
	currentAmount: '500000',
	checkedAt: '2026-07-19T12:00:00.000Z',
};

describe('webhookQueueService.queueWebhookInTransaction', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockWebhookEndpointFindMany.mockResolvedValue([{ id: 'endpoint-1' }]);
		mockWebhookDeliveryCreate.mockResolvedValue({ id: 'delivery-1' });
	});

	function createTransactionClient() {
		return {
			webhookEndpoint: {
				findMany: mockWebhookEndpointFindMany,
			},
			webhookDelivery: {
				create: mockWebhookDeliveryCreate,
			},
		};
	}

	it('queues the outbox delivery using the supplied transaction client', async () => {
		const tx = createTransactionClient();

		await webhookQueueService.queueWebhookInTransaction(
			tx as never,
			WebhookEventType.WALLET_LOW_BALANCE,
			lowBalancePayload,
			'wallet-1',
			'payment-source-1',
		);

		expect(mockWebhookEndpointFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					isActive: true,
					events: { has: WebhookEventType.WALLET_LOW_BALANCE },
				}),
			}),
		);
		expect(mockWebhookDeliveryCreate).toHaveBeenCalledWith({
			data: expect.objectContaining({
				webhookEndpointId: 'endpoint-1',
				eventType: WebhookEventType.WALLET_LOW_BALANCE,
				entityId: 'wallet-1',
				status: WebhookDeliveryStatus.Pending,
				payload: expect.objectContaining({
					webhook_id: 'endpoint-1',
					event_type: WebhookEventType.WALLET_LOW_BALANCE,
				}),
			}),
		});
	});

	it('rejects so the enclosing state transition rolls back if queuing fails', async () => {
		const tx = createTransactionClient();
		mockWebhookDeliveryCreate.mockRejectedValue(new Error('database write failed'));

		await expect(
			webhookQueueService.queueWebhookInTransaction(
				tx as never,
				WebhookEventType.WALLET_LOW_BALANCE,
				lowBalancePayload,
				'wallet-1',
				'payment-source-1',
			),
		).rejects.toThrow('database write failed');
	});
});
