import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { Network, WebhookEventType } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const mockGlobalEndpointFindMany = jest.fn() as AnyMock;
const mockGlobalDeliveryCreate = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		webhookEndpoint: { findMany: mockGlobalEndpointFindMany },
		webhookDelivery: { create: mockGlobalDeliveryCreate },
	},
}));

jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONFIG: { OTEL_SERVICE_NAME: 'masumi-test-service' },
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('./sender.service', () => ({
	webhookSenderService: { processWebhookDelivery: jest.fn() },
}));

const { webhookQueueService } = await import('./queue.service');

const sentPayload = {
	batchId: 'batch-1',
	fundWalletId: 'fund-1',
	fundWalletAddress: 'addr_fund',
	network: Network.Preprod,
	txHash: 'tx-hash-1',
	distributions: [
		{
			requestId: 'req-1',
			targetWalletId: 'wallet-1',
			targetWalletAddress: 'addr_target',
			assetUnit: 'lovelace',
			amount: '20000000',
		},
	],
};

describe('webhookQueueService.queueWebhookInTransaction', () => {
	it('rejects when a delivery cannot be persisted so the caller transaction can roll back', async () => {
		const endpointFindMany = jest.fn<(...args: any[]) => any>().mockResolvedValue([{ id: 'webhook-1' }]);
		const deliveryCreate = jest.fn<(...args: any[]) => any>().mockRejectedValue(new Error('db write failed'));
		const tx = {
			webhookEndpoint: { findMany: endpointFindMany },
			webhookDelivery: { create: deliveryCreate },
		};

		await expect(
			webhookQueueService.queueWebhookInTransaction(
				tx as never,
				WebhookEventType.FUND_DISTRIBUTION_SENT,
				sentPayload,
				'fund-1',
				'ps-1',
			),
		).rejects.toThrow('db write failed');
		expect(mockGlobalDeliveryCreate).not.toHaveBeenCalled();
	});
});
