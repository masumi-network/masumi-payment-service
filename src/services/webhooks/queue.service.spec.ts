import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { Network, WebhookEventType, X402EvmWalletType } from '@/generated/prisma/client';

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

const x402PaymentPayload = {
	attemptId: 'attempt-1',
	paymentPayloadHash: 'payload-hash',
	supportedPaymentSourceId: 'evm-source-1',
	registryRequestId: 'request-1',
	caip2Network: 'eip155:8453',
	asset: '0x1234',
	amount: '1000000',
	payTo: '0x5678',
	payer: '0x9abc',
	txHash: '0xdef0',
	success: true,
	errorReason: null,
	errorMessage: null,
	settledAt: '2026-10-26T00:00:00.000Z',
};

const x402LowBalancePayload = {
	ruleId: 'rule-1',
	evmWalletId: 'evm-wallet-1',
	walletAddress: '0x1234',
	walletType: X402EvmWalletType.Purchasing,
	caip2Network: 'eip155:8453',
	asset: 'native',
	thresholdAmount: '1000000',
	currentAmount: '500000',
	checkedAt: '2026-10-26T00:00:00.000Z',
};

describe('webhookQueueService.queueWebhook', () => {
	it.each([
		[WebhookEventType.X402_PAYMENT_SETTLED, x402PaymentPayload],
		[WebhookEventType.X402_PAYMENT_FAILED, { ...x402PaymentPayload, success: false }],
		[WebhookEventType.X402_WALLET_LOW_BALANCE, x402LowBalancePayload],
	] as const)('queues %s only for global endpoints', async (eventType, payload) => {
		const endpoints = [
			{ id: 'scoped-source-1', paymentSourceId: 'source-1' },
			{ id: 'scoped-source-2', paymentSourceId: 'source-2' },
			{ id: 'global', paymentSourceId: null },
		];
		mockGlobalEndpointFindMany.mockReset();
		mockGlobalDeliveryCreate.mockReset();
		mockGlobalEndpointFindMany.mockImplementation(async ({ where }: { where: { paymentSourceId?: string | null } }) =>
			where.paymentSourceId === null ? endpoints.filter((endpoint) => endpoint.paymentSourceId === null) : endpoints,
		);
		mockGlobalDeliveryCreate.mockResolvedValue({});

		await webhookQueueService.queueWebhook(eventType, payload, 'entity-1');

		expect(mockGlobalEndpointFindMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: expect.objectContaining({ paymentSourceId: null }) }),
		);
		expect(mockGlobalDeliveryCreate.mock.calls.map(([call]) => call.data.webhookEndpointId)).toEqual(['global']);
	});
});

describe('webhookQueueService.queueWebhookInTransaction', () => {
	beforeEach(() => {
		mockGlobalDeliveryCreate.mockClear();
	});

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
