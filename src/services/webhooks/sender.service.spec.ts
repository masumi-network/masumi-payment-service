import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { WebhookEventType, WebhookFormat } from '@/generated/prisma/client';
import type { StoredWebhookPayload } from '@/types/webhook-payloads';

const mockWebhookEndpointFindUnique = jest.fn() as jest.Mock<any>;
const mockWebhookEndpointUpdate = jest.fn() as jest.Mock<any>;
const mockWebhookDeliveryFindUnique = jest.fn() as jest.Mock<any>;
const mockWebhookDeliveryUpdate = jest.fn() as jest.Mock<any>;
const mockHydraHeadFindUnique = jest.fn() as jest.Mock<any>;
const mockAssertWebhookDestinationAllowed = jest.fn() as jest.Mock<any>;
const loggerInfo = jest.fn() as jest.Mock<any>;
const loggerWarn = jest.fn() as jest.Mock<any>;
const loggerError = jest.fn() as jest.Mock<any>;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		webhookEndpoint: {
			findUnique: mockWebhookEndpointFindUnique,
			update: mockWebhookEndpointUpdate,
		},
		webhookDelivery: {
			findUnique: mockWebhookDeliveryFindUnique,
			update: mockWebhookDeliveryUpdate,
		},
		hydraHead: { findUnique: mockHydraHeadFindUnique },
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: {
		info: loggerInfo,
		warn: loggerWarn,
		error: loggerError,
		debug: jest.fn(),
	},
}));

jest.unstable_mockModule('@/utils/security/webhook-secrets', () => ({
	decryptWebhookUrlForDelivery: jest.fn((url: string) =>
		url === 'broken-url' ? null : url.startsWith('enc:') ? url.slice(4) : url,
	),
	decryptWebhookAuthTokenSafe: jest.fn((authToken: string | null) => {
		if (authToken == null) {
			return null;
		}

		if (authToken === 'broken-auth') {
			return null;
		}

		return authToken.startsWith('enc:') ? authToken.slice(4) : authToken;
	}),
}));

jest.unstable_mockModule('@/utils/security/webhook-destination-policy', () => ({
	assertWebhookDestinationAllowed: mockAssertWebhookDestinationAllowed,
	isWebhookDestinationPolicyError: jest.fn((error: unknown) => error instanceof Error && error.message === 'blocked'),
	redactWebhookDestination: jest.fn((url: string) => `redacted:${url}`),
	WEBHOOK_DELIVERY_BLOCKED_MESSAGE: 'Delivery blocked by policy',
}));

const { webhookSenderService } = await import('./sender.service');

describe('webhookSenderService.sendWebhook', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockAssertWebhookDestinationAllowed.mockResolvedValue(undefined);
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
				redirect: 'manual',
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
				redirect: 'manual',
			}),
		);
		const slackBody = JSON.parse(((global.fetch as jest.Mock).mock.calls[0][1] as { body: string }).body);
		expect(slackBody).toEqual({
			text: [
				'💸 Payment status updated',
				'🛰️ Service: masumi-test-service',
				'',
				'🏷️ ID: payment-2',
				'⛓️ Blockchain ID: blockchain-2',
				'🏦 Payment source: payment-source-2',
				'🌐 Network: Mainnet',
				'📍 On-chain state: Settled',
				'➡️ Next action: None',
				'⏱️ Event time: 2026-04-08T11:00:00.000Z',
			].join('\n'),
		});
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
				redirect: 'manual',
			}),
		);
		const googleChatBody = JSON.parse(((global.fetch as jest.Mock).mock.calls[0][1] as { body: string }).body);
		expect(googleChatBody).toEqual({
			text: [
				'🚨 Purchase error',
				'🛰️ Service: masumi-test-service',
				'',
				'🏷️ ID: purchase-1',
				'⛓️ Blockchain ID: purchase-chain-1',
				'🏦 Payment source: payment-source-3',
				'🌐 Network: Preprod',
				'📍 On-chain state: Disputed',
				'➡️ Next action: SubmitEvidence',
				'⚠️ Error type: VALIDATION_ERROR',
				'📝 Error note: Result hash mismatch',
				'⏱️ Event time: 2026-04-08T12:00:00.000Z',
			].join('\n'),
		});
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
				redirect: 'manual',
			}),
		);
		const discordBody = JSON.parse(((global.fetch as jest.Mock).mock.calls[0][1] as { body: string }).body);
		expect(discordBody).toEqual({
			content: [
				'🪫 Wallet balance low',
				'🛰️ Service: masumi-test-service',
				'',
				'👛 Wallet ID: wallet-1',
				'📬 Wallet address: addr_test1...',
				'🏦 Payment source: payment-source-4',
				'🌐 Network: Preprod',
				'🎯 Threshold: 5 ADA',
				'💰 New balance: 4.5 ADA',
				'🕒 Checked at: 2026-04-08T12:59:00.000Z',
				'⏱️ Event time: 2026-04-08T13:00:00.000Z',
			].join('\n'),
		});
	});

	it('shows a few transactions of a stuck snapshot round and counts the rest', async () => {
		const txIds = Array.from({ length: 7 }, (_, i) => `tx${i}`);
		const payload = {
			event_type: WebhookEventType.HYDRA_HEAD_SNAPSHOT_ROUND_STUCK,
			service_name: 'masumi-test-service',
			timestamp: '2026-10-16T12:00:00.000Z',
			webhook_id: 'webhook-5',
			data: {
				hydraHeadId: 'head-1',
				roundTag: 'SeenSnapshot',
				snapshotNumber: 314,
				signatoryCount: 1,
				txIds,
				stuckSince: '2026-10-16T11:50:00.000Z',
				checkedAt: '2026-10-16T12:00:00.000Z',
			},
		} as unknown as StoredWebhookPayload;

		await webhookSenderService.sendWebhook(
			'https://discord.com/api/webhooks/test/token',
			WebhookFormat.DISCORD,
			null,
			payload,
		);

		const discordBody = JSON.parse(((global.fetch as jest.Mock).mock.calls[0][1] as { body: string }).body);
		expect(discordBody.content).toContain('🧊 Hydra snapshot round stuck');
		expect(discordBody.content).toContain('🧾 Transactions: tx0, tx1, tx2, tx3, tx4 (+2 more)');
	});

	// A node reason can be 2000 characters on its own, and Discord refuses a
	// message longer than that, so the alert about a failed contest never arrived.
	it('keeps a failed L1 post alert under the Discord message limit', async () => {
		const payload = {
			event_type: WebhookEventType.HYDRA_HEAD_POST_TX_FAILED,
			service_name: 'masumi-test-service',
			timestamp: '2026-10-22T12:00:00.000Z',
			webhook_id: 'webhook-6',
			data: {
				hydraHeadId: 'head-1',
				headStatus: 'Closed',
				postChainTxTag: 'ContestTx',
				reason: `FailedToPostTx: the chain backend refused the transaction (${'x'.repeat(2000)})`,
				reportedToCaller: false,
				failedAt: '2026-10-22T12:00:00.000Z',
			},
		} as unknown as StoredWebhookPayload;

		await webhookSenderService.sendWebhook(
			'https://discord.com/api/webhooks/test/token',
			WebhookFormat.DISCORD,
			null,
			payload,
		);

		const discordBody = JSON.parse(((global.fetch as jest.Mock).mock.calls[0][1] as { body: string }).body);
		expect(discordBody.content).toContain('🧾 Transaction: ContestTx');
		expect(discordBody.content.length).toBeLessThan(2000);
	});

	it('blocks private destinations before making an outbound request and logs only the redacted destination', async () => {
		mockAssertWebhookDestinationAllowed.mockRejectedValue(new Error('blocked'));

		const result = await webhookSenderService.sendWebhook(
			'http://127.0.0.1/webhook',
			WebhookFormat.EXTENDED,
			'extended-secret',
			{
				event_type: WebhookEventType.PAYMENT_ON_ERROR,
				service_name: 'masumi-test-service',
				timestamp: '2026-04-08T10:00:00.000Z',
				webhook_id: 'webhook-1',
				data: {
					id: 'payment-1',
				},
			} as unknown as StoredWebhookPayload,
		);

		expect(result).toEqual({
			success: false,
			errorMessage: 'Delivery blocked by policy',
			durationMs: 0,
		});
		expect(global.fetch).not.toHaveBeenCalled();
		expect(loggerWarn).toHaveBeenCalledWith(
			'Webhook delivery blocked by policy',
			expect.objectContaining({
				url: 'redacted:http://127.0.0.1/webhook',
			}),
		);
	});
});

describe('webhookSenderService.sendTestWebhook', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockAssertWebhookDestinationAllowed.mockResolvedValue(undefined);
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
				redirect: 'manual',
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
				redirect: 'manual',
			}),
		);
		const slackRequest = (global.fetch as jest.Mock).mock.calls[0][1] as { body: string };
		const slackBody = JSON.parse(slackRequest.body);
		expect(slackBody.text).toContain('🧪 Test webhook delivery');
		expect(slackBody.text).toContain('🛰️ Service: masumi-test-service');
		expect(slackBody.text).toContain('💬 Message: This is a test webhook delivery from Masumi.');
		expect(slackBody.text).toContain('🔔 Webhook: Slack alerts');
		expect(slackBody.text).toContain('🏦 Payment source: payment-source-2');
		expect(slackBody.text).not.toContain('📦 Format:');
		expect(slackBody.text).not.toContain('👤 Triggered by API key:');
		expect(slackBody.text).toMatch(/🕒 Sent at: /);
	});
});

describe('webhookSenderService.processWebhookDelivery', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockAssertWebhookDestinationAllowed.mockResolvedValue(undefined);
		mockWebhookEndpointFindUnique.mockResolvedValue({
			id: 'webhook-legacy',
			consecutiveFailures: 0,
		});
		mockWebhookEndpointUpdate.mockResolvedValue(undefined);
		mockWebhookDeliveryUpdate.mockResolvedValue(undefined);
		global.fetch = jest.fn(
			async () =>
				({
					ok: true,
					status: 200,
					statusText: 'OK',
				}) as Response,
		) as typeof fetch;
	});

	it('processes legacy queued deliveries that do not include service_name', async () => {
		mockWebhookDeliveryFindUnique.mockResolvedValue({
			id: 'delivery-1',
			webhookEndpointId: 'webhook-legacy',
			attempts: 0,
			maxAttempts: 3,
			payload: {
				event_type: WebhookEventType.WALLET_LOW_BALANCE,
				timestamp: '2026-04-08T13:00:00.000Z',
				webhook_id: 'webhook-legacy',
				data: {
					walletId: 'wallet-legacy',
					walletAddress: 'addr_test1legacy',
					paymentSourceId: 'payment-source-legacy',
					network: 'Preprod',
					assetUnit: 'lovelace',
					currentAmount: '4500000',
					thresholdAmount: '5000000',
					checkedAt: '2026-04-08T12:59:00.000Z',
				},
			},
			WebhookEndpoint: {
				id: 'webhook-legacy',
				url: 'https://hooks.slack.com/services/legacy',
				format: WebhookFormat.SLACK,
				authToken: null,
				isActive: true,
			},
		});
		mockWebhookDeliveryUpdate.mockResolvedValueOnce({ attempts: 1 }).mockResolvedValueOnce(undefined);

		await webhookSenderService.processWebhookDelivery('delivery-1');

		expect(global.fetch).toHaveBeenCalledWith(
			'https://hooks.slack.com/services/legacy',
			expect.objectContaining({
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'User-Agent': 'Masumi-Webhook/1.0',
				},
				redirect: 'manual',
			}),
		);
		const slackBody = JSON.parse(((global.fetch as jest.Mock).mock.calls[0][1] as { body: string }).body);
		expect(slackBody.text).toContain('🪫 Wallet balance low');
		expect(slackBody.text).not.toContain('🛰️ Service:');
		expect(mockWebhookEndpointUpdate).toHaveBeenCalledWith({
			where: { id: 'webhook-legacy' },
			data: {
				lastSuccessAt: expect.any(Date),
				consecutiveFailures: 0,
			},
		});
	});

	it('cancels an old Hydra delivery queued for a different source before sending it', async () => {
		mockHydraHeadFindUnique.mockResolvedValue({
			HydraRelation: { localHotWalletId: 'wallet-1', LocalHotWallet: { paymentSourceId: 'source-1' } },
			LocalParticipant: { id: 'participant-1', walletId: 'wallet-1' },
		});
		mockWebhookDeliveryFindUnique.mockResolvedValue({
			id: 'delivery-wrong-source',
			webhookEndpointId: 'webhook-source-2',
			eventType: WebhookEventType.HYDRA_HEAD_POST_TX_FAILED,
			attempts: 0,
			maxAttempts: 3,
			payload: {
				event_type: WebhookEventType.HYDRA_HEAD_POST_TX_FAILED,
				timestamp: '2026-10-26T00:00:00.000Z',
				webhook_id: 'webhook-source-2',
				data: { hydraHeadId: 'head-1' },
			},
			WebhookEndpoint: {
				id: 'webhook-source-2',
				url: 'https://example.com/webhook',
				format: WebhookFormat.EXTENDED,
				authToken: 'secret',
				isActive: true,
				paymentSourceId: 'source-2',
			},
		});
		mockWebhookDeliveryUpdate.mockResolvedValueOnce({ attempts: 1 }).mockResolvedValueOnce(undefined);

		await webhookSenderService.processWebhookDelivery('delivery-wrong-source');

		expect(global.fetch).not.toHaveBeenCalled();
		expect(mockWebhookDeliveryUpdate).toHaveBeenCalledWith({
			where: { id: 'delivery-wrong-source' },
			data: expect.objectContaining({ status: 'Cancelled' }),
		});
	});

	it('sends an old Hydra delivery queued for its owning source', async () => {
		mockHydraHeadFindUnique.mockResolvedValue({
			HydraRelation: { localHotWalletId: 'wallet-1', LocalHotWallet: { paymentSourceId: 'source-1' } },
			LocalParticipant: { id: 'participant-1', walletId: 'wallet-1' },
		});
		mockWebhookDeliveryFindUnique.mockResolvedValue({
			id: 'delivery-right-source',
			webhookEndpointId: 'webhook-source-1',
			eventType: WebhookEventType.HYDRA_HEAD_POST_TX_FAILED,
			attempts: 0,
			maxAttempts: 3,
			payload: {
				event_type: WebhookEventType.HYDRA_HEAD_POST_TX_FAILED,
				timestamp: '2026-10-26T00:00:00.000Z',
				webhook_id: 'webhook-source-1',
				data: { hydraHeadId: 'head-1' },
			},
			WebhookEndpoint: {
				id: 'webhook-source-1',
				url: 'https://example.com/webhook',
				format: WebhookFormat.EXTENDED,
				authToken: 'secret',
				isActive: true,
				paymentSourceId: 'source-1',
			},
		});
		mockWebhookDeliveryUpdate.mockResolvedValueOnce({ attempts: 1 }).mockResolvedValueOnce(undefined);

		await webhookSenderService.processWebhookDelivery('delivery-right-source');

		expect(global.fetch).toHaveBeenCalledTimes(1);
		expect(mockWebhookDeliveryUpdate).toHaveBeenCalledWith({
			where: { id: 'delivery-right-source' },
			data: expect.objectContaining({ status: 'Success' }),
		});
	});

	it('cancels an old scoped Hydra row with no Head id before sending it', async () => {
		mockWebhookDeliveryFindUnique.mockResolvedValue({
			id: 'delivery-no-head',
			webhookEndpointId: 'webhook-source-1',
			eventType: WebhookEventType.HYDRA_HEAD_POST_TX_FAILED,
			attempts: 0,
			maxAttempts: 3,
			payload: {
				event_type: WebhookEventType.HYDRA_HEAD_POST_TX_FAILED,
				timestamp: '2026-10-26T00:00:00.000Z',
				webhook_id: 'webhook-source-1',
				data: { hydraHeadId: 42 },
			},
			WebhookEndpoint: {
				id: 'webhook-source-1',
				url: 'https://example.com/webhook',
				format: WebhookFormat.EXTENDED,
				authToken: 'secret',
				isActive: true,
				paymentSourceId: 'source-1',
			},
		});
		mockWebhookDeliveryUpdate.mockResolvedValueOnce({ attempts: 1 }).mockResolvedValueOnce(undefined);

		await webhookSenderService.processWebhookDelivery('delivery-no-head');

		expect(global.fetch).not.toHaveBeenCalled();
		expect(mockHydraHeadFindUnique).not.toHaveBeenCalled();
		expect(mockWebhookDeliveryUpdate).toHaveBeenCalledWith({
			where: { id: 'delivery-no-head' },
			data: expect.objectContaining({ status: 'Cancelled' }),
		});
	});

	it('retries a scoped Hydra delivery when its source lookup fails', async () => {
		mockHydraHeadFindUnique.mockRejectedValue(new Error('database unavailable'));
		mockWebhookDeliveryFindUnique.mockResolvedValue({
			id: 'delivery-lookup-failed',
			webhookEndpointId: 'webhook-source-1',
			eventType: WebhookEventType.HYDRA_HEAD_POST_TX_FAILED,
			attempts: 0,
			maxAttempts: 3,
			payload: {
				event_type: WebhookEventType.HYDRA_HEAD_POST_TX_FAILED,
				timestamp: '2026-10-26T00:00:00.000Z',
				webhook_id: 'webhook-source-1',
				data: { hydraHeadId: 'head-1' },
			},
			WebhookEndpoint: {
				id: 'webhook-source-1',
				url: 'https://example.com/webhook',
				format: WebhookFormat.EXTENDED,
				authToken: 'secret',
				isActive: true,
				paymentSourceId: 'source-1',
			},
		});
		mockWebhookDeliveryUpdate.mockResolvedValueOnce({ attempts: 1 }).mockResolvedValueOnce(undefined);

		await webhookSenderService.processWebhookDelivery('delivery-lookup-failed');

		expect(global.fetch).not.toHaveBeenCalled();
		expect(mockWebhookDeliveryUpdate).toHaveBeenCalledWith({
			where: { id: 'delivery-lookup-failed' },
			data: expect.objectContaining({ status: 'Retrying', nextRetryAt: expect.any(Date) }),
		});
	});

	it('still sends a Hydra delivery queued for a global endpoint', async () => {
		mockWebhookDeliveryFindUnique.mockResolvedValue({
			id: 'delivery-global',
			webhookEndpointId: 'webhook-global',
			eventType: WebhookEventType.HYDRA_HEAD_POST_TX_FAILED,
			attempts: 0,
			maxAttempts: 3,
			payload: {
				event_type: WebhookEventType.HYDRA_HEAD_POST_TX_FAILED,
				timestamp: '2026-10-26T00:00:00.000Z',
				webhook_id: 'webhook-global',
				data: { hydraHeadId: 'head-1' },
			},
			WebhookEndpoint: {
				id: 'webhook-global',
				url: 'https://example.com/webhook',
				format: WebhookFormat.EXTENDED,
				authToken: 'secret',
				isActive: true,
				paymentSourceId: null,
			},
		});
		mockWebhookDeliveryUpdate.mockResolvedValueOnce({ attempts: 1 }).mockResolvedValueOnce(undefined);

		await webhookSenderService.processWebhookDelivery('delivery-global');

		expect(global.fetch).toHaveBeenCalledTimes(1);
		expect(mockHydraHeadFindUnique).not.toHaveBeenCalled();
	});
});
