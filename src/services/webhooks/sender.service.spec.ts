import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { WebhookEventType, WebhookFormat } from '@/generated/prisma/client';
import type { StoredWebhookPayload } from '@/types/webhook-payloads';

const mockWebhookEndpointFindUnique = jest.fn() as jest.Mock<any>;
const mockWebhookEndpointUpdate = jest.fn() as jest.Mock<any>;
const mockWebhookDeliveryFindUnique = jest.fn() as jest.Mock<any>;
const mockWebhookDeliveryUpdate = jest.fn() as jest.Mock<any>;

jest.unstable_mockModule('@/utils/db', () => ({
	prisma: {
		webhookEndpoint: {
			findUnique: mockWebhookEndpointFindUnique,
			update: mockWebhookEndpointUpdate,
		},
		webhookDelivery: {
			findUnique: mockWebhookDeliveryFindUnique,
			update: mockWebhookDeliveryUpdate,
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

const { webhookSenderService } = await import('./sender.service');

describe('webhookSenderService.sendWebhook', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockWebhookEndpointFindUnique.mockResolvedValue({
			id: 'webhook-1',
			consecutiveFailures: 3,
		});
		mockWebhookEndpointUpdate.mockResolvedValue(undefined);
		global.fetch = jest.fn(
			async () =>
				({
					ok: true,
					status: 200,
					statusText: 'OK',
				}) as Response,
		) as typeof fetch;
	});

	it('sends extended payloads with bearer auth and service_name in the JSON body', async () => {
		const payload = {
			event_type: WebhookEventType.PAYMENT_ON_ERROR,
			service_name: 'masumi-test-service',
			timestamp: '2026-04-08T10:00:00.000Z',
			webhook_id: 'webhook-1',
			data: {
				id: 'payment-1',
				blockchainIdentifier: 'blockchain-1',
				onChainState: 'Failed',
				PaymentSource: {
					id: 'payment-source-1',
					network: 'Preprod',
				},
				NextAction: {
					requestedAction: 'RetryRequested',
					errorType: 'NETWORK_ERROR',
					errorNote: 'Unable to connect to blockchain node',
				},
			},
		} as unknown as StoredWebhookPayload;

		await webhookSenderService.sendWebhook(
			'https://example.com/webhook',
			WebhookFormat.EXTENDED,
			'extended-secret',
			payload,
		);

		expect(global.fetch).toHaveBeenCalledWith(
			'https://example.com/webhook',
			expect.objectContaining({
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: 'Bearer extended-secret',
					'X-Masumi-Event': WebhookEventType.PAYMENT_ON_ERROR,
					'X-Masumi-Timestamp': '2026-04-08T10:00:00.000Z',
					'User-Agent': 'Masumi-Webhook/1.0',
				},
				body: JSON.stringify(payload),
			}),
		);
	});

	it('sends slack payloads as compact summaries without auth headers', async () => {
		const payload = {
			event_type: WebhookEventType.PAYMENT_ON_CHAIN_STATUS_CHANGED,
			service_name: 'masumi-test-service',
			timestamp: '2026-04-08T11:00:00.000Z',
			webhook_id: 'webhook-2',
			data: {
				id: 'payment-2',
				blockchainIdentifier: 'blockchain-2',
				onChainState: 'Settled',
				PaymentSource: {
					id: 'payment-source-2',
					network: 'Mainnet',
				},
				NextAction: {
					requestedAction: 'None',
					errorType: null,
					errorNote: null,
				},
			},
		} as unknown as StoredWebhookPayload;

		await webhookSenderService.sendWebhook('https://hooks.slack.com/services/test', WebhookFormat.SLACK, null, payload);

		expect(global.fetch).toHaveBeenCalledWith(
			'https://hooks.slack.com/services/test',
			expect.objectContaining({
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'User-Agent': 'Masumi-Webhook/1.0',
				},
				body: JSON.stringify({
					text: [
						'[masumi-test-service] PAYMENT_ON_CHAIN_STATUS_CHANGED',
						'id: payment-2',
						'blockchainIdentifier: blockchain-2',
						'paymentSourceId: payment-source-2',
						'network: Mainnet',
						'onChainState: Settled',
						'nextAction: None',
						'timestamp: 2026-04-08T11:00:00.000Z',
					].join('\n'),
				}),
			}),
		);
	});

	it('sends google chat payloads as compact summaries without auth headers', async () => {
		const payload = {
			event_type: WebhookEventType.PURCHASE_ON_ERROR,
			service_name: 'masumi-test-service',
			timestamp: '2026-04-08T12:00:00.000Z',
			webhook_id: 'webhook-3',
			data: {
				id: 'purchase-1',
				blockchainIdentifier: 'purchase-chain-1',
				onChainState: 'Disputed',
				PaymentSource: {
					id: 'payment-source-3',
					network: 'Preprod',
				},
				NextAction: {
					requestedAction: 'SubmitEvidence',
					errorType: 'VALIDATION_ERROR',
					errorNote: 'Result hash mismatch',
				},
			},
		} as unknown as StoredWebhookPayload;

		await webhookSenderService.sendWebhook(
			'https://chat.googleapis.com/v1/spaces/space/messages?key=key&token=token',
			WebhookFormat.GOOGLE_CHAT,
			null,
			payload,
		);

		expect(global.fetch).toHaveBeenCalledWith(
			'https://chat.googleapis.com/v1/spaces/space/messages?key=key&token=token',
			expect.objectContaining({
				method: 'POST',
				headers: {
					'Content-Type': 'application/json; charset=UTF-8',
					'User-Agent': 'Masumi-Webhook/1.0',
				},
				body: JSON.stringify({
					text: [
						'[masumi-test-service] PURCHASE_ON_ERROR',
						'id: purchase-1',
						'blockchainIdentifier: purchase-chain-1',
						'paymentSourceId: payment-source-3',
						'network: Preprod',
						'onChainState: Disputed',
						'nextAction: SubmitEvidence',
						'errorType: VALIDATION_ERROR',
						'errorNote: Result hash mismatch',
						'timestamp: 2026-04-08T12:00:00.000Z',
					].join('\n'),
				}),
			}),
		);
	});

	it('sends discord payloads as compact summaries without auth headers', async () => {
		const payload = {
			event_type: WebhookEventType.WALLET_LOW_BALANCE,
			service_name: 'masumi-test-service',
			timestamp: '2026-04-08T13:00:00.000Z',
			webhook_id: 'webhook-4',
			data: {
				walletId: 'wallet-1',
				walletAddress: 'addr_test1...',
				paymentSourceId: 'payment-source-4',
				network: 'Preprod',
				assetUnit: 'lovelace',
				currentAmount: '4500000',
				thresholdAmount: '5000000',
				checkedAt: '2026-04-08T12:59:00.000Z',
			},
		} as unknown as StoredWebhookPayload;

		await webhookSenderService.sendWebhook(
			'https://discord.com/api/webhooks/test/token',
			WebhookFormat.DISCORD,
			null,
			payload,
		);

		expect(global.fetch).toHaveBeenCalledWith(
			'https://discord.com/api/webhooks/test/token',
			expect.objectContaining({
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'User-Agent': 'Masumi-Webhook/1.0',
				},
				body: JSON.stringify({
					content: [
						'[masumi-test-service] WALLET_LOW_BALANCE',
						'walletId: wallet-1',
						'walletAddress: addr_test1...',
						'paymentSourceId: payment-source-4',
						'network: Preprod',
						'assetUnit: lovelace',
						'currentAmount: 4500000',
						'thresholdAmount: 5000000',
						'checkedAt: 2026-04-08T12:59:00.000Z',
						'timestamp: 2026-04-08T13:00:00.000Z',
					].join('\n'),
				}),
			}),
		);
	});
});

describe('webhookSenderService.sendTestWebhook', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockWebhookEndpointFindUnique.mockResolvedValue({
			id: 'webhook-test',
			consecutiveFailures: 3,
		});
		mockWebhookEndpointUpdate.mockResolvedValue(undefined);
		global.fetch = jest.fn(
			async () =>
				({
					ok: true,
					status: 200,
					statusText: 'OK',
				}) as Response,
		) as typeof fetch;
	});

	it('sends test deliveries to extended webhooks with a dedicated WEBHOOK_TEST payload', async () => {
		await webhookSenderService.sendTestWebhook(
			{
				id: 'webhook-test',
				url: 'https://example.com/webhook',
				format: WebhookFormat.EXTENDED,
				authToken: 'extended-secret',
				name: 'External relay',
				paymentSourceId: 'payment-source-1',
			},
			'api-key-1',
			'masumi-test-service',
		);

		expect(global.fetch).toHaveBeenCalledWith(
			'https://example.com/webhook',
			expect.objectContaining({
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					Authorization: 'Bearer extended-secret',
					'X-Masumi-Event': 'WEBHOOK_TEST',
					'X-Masumi-Timestamp': expect.any(String),
					'User-Agent': 'Masumi-Webhook/1.0',
				},
			}),
		);
		const extendedRequest = (global.fetch as jest.Mock).mock.calls[0][1] as { body: string };
		const extendedBody = JSON.parse(extendedRequest.body);
		expect(extendedBody).toEqual({
			event_type: 'WEBHOOK_TEST',
			service_name: 'masumi-test-service',
			timestamp: expect.any(String),
			webhook_id: 'webhook-test',
			data: {
				message: 'This is a test webhook delivery from Masumi.',
				webhookName: 'External relay',
				webhookFormat: WebhookFormat.EXTENDED,
				paymentSourceId: 'payment-source-1',
				triggeredByApiKeyId: 'api-key-1',
			},
		});
		expect(mockWebhookEndpointUpdate).toHaveBeenCalledWith({
			where: { id: 'webhook-test' },
			data: {
				lastSuccessAt: expect.any(Date),
				consecutiveFailures: 0,
			},
		});
	});

	it('sends test deliveries to slack webhooks as compact test summaries', async () => {
		await webhookSenderService.sendTestWebhook(
			{
				id: 'webhook-test-2',
				url: 'https://hooks.slack.com/services/test',
				format: WebhookFormat.SLACK,
				authToken: null,
				name: 'Slack alerts',
				paymentSourceId: 'payment-source-2',
			},
			'api-key-9',
			'masumi-test-service',
		);

		expect(global.fetch).toHaveBeenCalledWith(
			'https://hooks.slack.com/services/test',
			expect.objectContaining({
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'User-Agent': 'Masumi-Webhook/1.0',
				},
			}),
		);
		const slackRequest = (global.fetch as jest.Mock).mock.calls[0][1] as { body: string };
		const slackBody = JSON.parse(slackRequest.body);
		expect(slackBody.text).toContain('[masumi-test-service] WEBHOOK_TEST');
		expect(slackBody.text).toContain('message: This is a test webhook delivery from Masumi.');
		expect(slackBody.text).toContain('webhookName: Slack alerts');
		expect(slackBody.text).toContain(`webhookFormat: ${WebhookFormat.SLACK}`);
		expect(slackBody.text).toContain('paymentSourceId: payment-source-2');
		expect(slackBody.text).toContain('triggeredByApiKeyId: api-key-9');
		expect(slackBody.text).toMatch(/timestamp: /);
	});
});
