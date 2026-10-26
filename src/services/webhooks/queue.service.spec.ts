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

	it('rejects a Hydra alert without a payment source before selecting endpoints', async () => {
		const endpointFindMany = jest.fn<(...args: any[]) => any>().mockResolvedValue([]);
		const deliveryCreate = jest.fn<(...args: any[]) => any>();
		const tx = {
			webhookEndpoint: { findMany: endpointFindMany },
			webhookDelivery: { create: deliveryCreate },
		};

		await expect(
			webhookQueueService.queueWebhookInTransaction(
				tx as never,
				WebhookEventType.HYDRA_HEAD_POST_TX_FAILED,
				{
					hydraHeadId: 'head-1',
					headStatus: 'Closed',
					postChainTxTag: 'ContestTx',
					reason: 'refused',
					reportedToCaller: false,
					failedAt: '2026-10-26T00:00:00.000Z',
				},
				'head-1',
			),
		).rejects.toThrow('payment source');
		expect(endpointFindMany).not.toHaveBeenCalled();
		expect(deliveryCreate).not.toHaveBeenCalled();
	});

	it('queues only the owning source and global endpoints for a Hydra alert', async () => {
		const endpoints = [
			{ id: 'scoped-source-1', paymentSourceId: 'source-1' },
			{ id: 'scoped-source-2', paymentSourceId: 'source-2' },
			{ id: 'global', paymentSourceId: null },
		];
		const endpointFindMany = jest
			.fn<(...args: any[]) => any>()
			.mockImplementation(async ({ where }) =>
				endpoints.filter((endpoint) =>
					where.OR.some(
						({ paymentSourceId }: { paymentSourceId: string | null }) => endpoint.paymentSourceId === paymentSourceId,
					),
				),
			);
		const deliveryCreate = jest.fn<(...args: any[]) => any>().mockResolvedValue({});
		const tx = {
			webhookEndpoint: { findMany: endpointFindMany },
			webhookDelivery: { create: deliveryCreate },
		};

		await webhookQueueService.queueWebhookInTransaction(
			tx as never,
			WebhookEventType.HYDRA_HEAD_POST_TX_FAILED,
			{
				hydraHeadId: 'head-1',
				headStatus: 'Closed',
				postChainTxTag: 'ContestTx',
				reason: 'refused',
				reportedToCaller: false,
				failedAt: '2026-10-26T00:00:00.000Z',
			},
			'head-1',
			'source-1',
		);

		expect(endpointFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ OR: [{ paymentSourceId: 'source-1' }, { paymentSourceId: null }] }),
			}),
		);
		expect(deliveryCreate.mock.calls.map(([call]) => call.data.webhookEndpointId)).toEqual([
			'scoped-source-1',
			'global',
		]);
	});
});
