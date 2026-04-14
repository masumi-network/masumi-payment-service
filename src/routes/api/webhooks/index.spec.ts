import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { testEndpoint } from 'express-zod-api';
import { ApiKeyStatus, Network, WebhookFormat } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindApiKey = jest.fn() as AnyMock;
const mockFindExistingWebhook = jest.fn() as AnyMock;
const mockCreateWebhook = jest.fn() as AnyMock;
const mockListWebhooks = jest.fn() as AnyMock;
const mockFindWebhookById = jest.fn() as AnyMock;
const mockUpdateWebhook = jest.fn() as AnyMock;
const mockFindPaymentSource = jest.fn() as AnyMock;
const mockSendTestWebhook = jest.fn() as AnyMock;
const mockAssertWebhookDestinationAllowed = jest.fn() as AnyMock;

jest.unstable_mockModule('@/utils/db', () => ({
	prisma: {
		apiKey: {
			findUnique: mockFindApiKey,
		},
		webhookEndpoint: {
			findFirst: mockFindExistingWebhook,
			create: mockCreateWebhook,
			findMany: mockListWebhooks,
			findUnique: mockFindWebhookById,
			update: mockUpdateWebhook,
			delete: jest.fn(),
		},
		paymentSource: {
			findUnique: mockFindPaymentSource,
		},
	},
}));

jest.unstable_mockModule('@/utils/security/encryption', () => ({
	decrypt: jest.fn(() => 'decrypted-token'),
}));

jest.unstable_mockModule('@/utils/security/webhook-secrets', () => ({
	generateWebhookUrlHash: jest.fn((url: string) => `hash:${url}`),
	encryptWebhookUrl: jest.fn((url: string) => `enc:${url}`),
	encryptWebhookAuthToken: jest.fn((authToken: string | null | undefined) =>
		authToken == null ? null : `enc:${authToken}`,
	),
	decryptWebhookUrlSafe: jest.fn((url: string) => (url.startsWith('enc:') ? url.slice(4) : url)),
	decryptWebhookAuthTokenSafe: jest.fn((authToken: string | null) =>
		authToken != null && authToken.startsWith('enc:') ? authToken.slice(4) : authToken,
	),
}));

jest.unstable_mockModule('@/utils/logger', () => ({
	logger: {
		info: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
		debug: jest.fn(),
	},
}));

jest.unstable_mockModule('@/utils/config', () => ({
	CONFIG: {
		ENCRYPTION_KEY: '12345678901234567890',
		OTEL_SERVICE_NAME: 'masumi-test-service',
	},
}));

jest.unstable_mockModule('@/services/webhooks/sender.service', () => ({
	webhookSenderService: {
		sendTestWebhook: mockSendTestWebhook,
	},
}));

jest.unstable_mockModule('@/utils/security/webhook-destination-policy', () => ({
	assertWebhookDestinationAllowed: mockAssertWebhookDestinationAllowed,
	isWebhookDestinationPolicyError: jest.fn((error: unknown) => error instanceof Error && error.message === 'blocked'),
	WEBHOOK_DESTINATION_NOT_ALLOWED_MESSAGE: 'Webhook destination is not allowed',
	WEBHOOK_DELIVERY_BLOCKED_MESSAGE: 'Delivery blocked by policy',
}));

const { registerWebhookPost, listWebhooksGet, patchWebhookPatch, testWebhookPost } = await import('./index');

describe('webhook endpoints', () => {
	const asApiKey = () => ({
		id: 'api-key-1',
		canRead: true,
		canPay: true,
		canAdmin: true,
		status: ApiKeyStatus.Active,
		token: null,
		tokenHash: null,
		tokenHashSecure: 'pbkdf2-placeholder',
		usageLimited: false,
		networkLimit: [],
		walletScopeEnabled: false,
		WalletScopes: [],
	});

	beforeEach(() => {
		jest.clearAllMocks();
		mockFindApiKey.mockResolvedValue(asApiKey());
		mockFindExistingWebhook.mockResolvedValue(null);
		mockAssertWebhookDestinationAllowed.mockResolvedValue(undefined);
		mockFindPaymentSource.mockResolvedValue({
			id: 'payment-source-1',
			network: Network.Preprod,
			deletedAt: null,
		});
		mockSendTestWebhook.mockResolvedValue({
			success: true,
			responseCode: 200,
			durationMs: 120,
		});
	});

	it('rejects missing authToken when format defaults to EXTENDED', async () => {
		const { responseMock } = await testEndpoint({
			endpoint: registerWebhookPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					url: 'https://example.com/webhooks/masumi',
					Events: ['PAYMENT_ON_ERROR'],
					name: 'Extended webhook',
				},
			},
		});

		expect(responseMock.statusCode).toBe(400);
		expect(mockCreateWebhook).not.toHaveBeenCalled();
	});

	it('defaults format to EXTENDED and requires authToken there', async () => {
		mockCreateWebhook.mockResolvedValue({
			id: 'webhook-1',
			url: 'https://example.com/webhooks/masumi',
			format: WebhookFormat.EXTENDED,
			authToken: 'extended-secret',
			events: ['PAYMENT_ON_ERROR'],
			name: 'Extended webhook',
			isActive: true,
			createdAt: new Date('2026-04-08T10:00:00.000Z'),
			paymentSourceId: null,
		});

		const { responseMock } = await testEndpoint({
			endpoint: registerWebhookPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					url: 'https://example.com/webhooks/masumi',
					authToken: 'extended-secret',
					Events: ['PAYMENT_ON_ERROR'],
					name: 'Extended webhook',
				},
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockFindExistingWebhook).toHaveBeenCalledWith({
			where: {
				urlHash: 'hash:https://example.com/webhooks/masumi',
				paymentSourceId: undefined,
				format: WebhookFormat.EXTENDED,
			},
		});
		expect(mockCreateWebhook).toHaveBeenCalledWith({
			data: expect.objectContaining({
				url: 'enc:https://example.com/webhooks/masumi',
				urlHash: 'hash:https://example.com/webhooks/masumi',
				authToken: 'enc:extended-secret',
				format: WebhookFormat.EXTENDED,
			}),
		});
		expect(responseMock._getJSONData()).toEqual({
			status: 'success',
			data: {
				id: 'webhook-1',
				url: 'https://example.com/webhooks/masumi',
				format: WebhookFormat.EXTENDED,
				Events: ['PAYMENT_ON_ERROR'],
				name: 'Extended webhook',
				isActive: true,
				createdAt: '2026-04-08T10:00:00.000Z',
				paymentSourceId: null,
			},
		});
	});

	it('rejects registering a blocked webhook destination', async () => {
		mockAssertWebhookDestinationAllowed.mockRejectedValue(new Error('blocked'));

		const { responseMock } = await testEndpoint({
			endpoint: registerWebhookPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					url: 'http://127.0.0.1/webhooks/masumi',
					authToken: 'extended-secret',
					Events: ['PAYMENT_ON_ERROR'],
					name: 'Blocked webhook',
				},
			},
		});

		expect(responseMock.statusCode).toBe(400);
		expect(responseMock._getJSONData()).toEqual({
			status: 'error',
			error: { message: 'Webhook destination is not allowed' },
		});
		expect(mockCreateWebhook).not.toHaveBeenCalled();
	});

	it('allows provider formats without authToken and stores null instead', async () => {
		mockCreateWebhook.mockResolvedValue({
			id: 'webhook-2',
			url: 'https://hooks.slack.com/services/abc/def/ghi',
			format: WebhookFormat.SLACK,
			authToken: null,
			events: ['WALLET_LOW_BALANCE'],
			name: 'Slack webhook',
			isActive: true,
			createdAt: new Date('2026-04-08T11:00:00.000Z'),
			paymentSourceId: null,
		});

		const { responseMock } = await testEndpoint({
			endpoint: registerWebhookPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					url: 'https://hooks.slack.com/services/abc/def/ghi',
					format: WebhookFormat.SLACK,
					Events: ['WALLET_LOW_BALANCE'],
					name: 'Slack webhook',
				},
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockCreateWebhook).toHaveBeenCalledWith({
			data: expect.objectContaining({
				url: 'enc:https://hooks.slack.com/services/abc/def/ghi',
				urlHash: 'hash:https://hooks.slack.com/services/abc/def/ghi',
				authToken: null,
				format: WebhookFormat.SLACK,
			}),
		});
		expect(responseMock._getJSONData().data).toEqual({
			id: 'webhook-2',
			url: 'https://hooks.slack.com/services/abc/def/ghi',
			format: WebhookFormat.SLACK,
			Events: ['WALLET_LOW_BALANCE'],
			name: 'Slack webhook',
			isActive: true,
			createdAt: '2026-04-08T11:00:00.000Z',
			paymentSourceId: null,
		});
	});

	it('includes format in list responses', async () => {
		mockListWebhooks.mockResolvedValue([
			{
				id: 'webhook-3',
				url: 'enc:https://discord.com/api/webhooks/id/token',
				format: WebhookFormat.DISCORD,
				events: ['PURCHASE_ON_ERROR'],
				name: 'Discord webhook',
				isActive: true,
				createdAt: new Date('2026-04-08T12:00:00.000Z'),
				updatedAt: new Date('2026-04-08T12:05:00.000Z'),
				paymentSourceId: 'payment-source-1',
				failureCount: 0,
				lastSuccessAt: new Date('2026-04-08T12:06:00.000Z'),
				disabledAt: null,
				CreatedByApiKey: {
					id: 'creator-1',
					encryptedToken: 'encrypted',
				},
			},
		]);

		const { responseMock } = await testEndpoint({
			endpoint: listWebhooksGet,
			requestProps: {
				method: 'GET',
				headers: { token: 'valid' },
				query: {},
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(responseMock._getJSONData()).toEqual({
			status: 'success',
			data: {
				Webhooks: [
					{
						id: 'webhook-3',
						url: 'https://discord.com/api/webhooks/id/token',
						format: WebhookFormat.DISCORD,
						Events: ['PURCHASE_ON_ERROR'],
						name: 'Discord webhook',
						isActive: true,
						createdAt: '2026-04-08T12:00:00.000Z',
						updatedAt: '2026-04-08T12:05:00.000Z',
						paymentSourceId: 'payment-source-1',
						failureCount: 0,
						lastSuccessAt: '2026-04-08T12:06:00.000Z',
						disabledAt: null,
						CreatedBy: {
							apiKeyId: 'creator-1',
							apiKeyToken: 'decrypted-token',
						},
					},
				],
			},
		});
	});

	it('allows the creator to patch a webhook and exclude itself from duplicate checks', async () => {
		mockFindWebhookById.mockResolvedValue({
			id: 'webhook-3',
			url: 'https://example.com/old',
			format: WebhookFormat.EXTENDED,
			authToken: 'old-secret',
			events: ['PAYMENT_ON_ERROR'],
			name: 'Webhook',
			isActive: true,
			createdAt: new Date('2026-04-08T12:00:00.000Z'),
			updatedAt: new Date('2026-04-08T12:05:00.000Z'),
			paymentSourceId: 'payment-source-1',
			createdByApiKeyId: 'api-key-1',
			PaymentSource: {
				id: 'payment-source-1',
				network: Network.Preprod,
				deletedAt: null,
			},
		});
		mockUpdateWebhook.mockResolvedValue({
			id: 'webhook-3',
			url: 'https://example.com/new',
			format: WebhookFormat.EXTENDED,
			authToken: 'new-secret',
			events: ['PAYMENT_ON_ERROR', 'WALLET_LOW_BALANCE'],
			name: 'Webhook updated',
			isActive: true,
			createdAt: new Date('2026-04-08T12:00:00.000Z'),
			updatedAt: new Date('2026-04-08T12:10:00.000Z'),
			paymentSourceId: 'payment-source-1',
		});

		const { responseMock } = await testEndpoint({
			endpoint: patchWebhookPatch,
			requestProps: {
				method: 'PATCH',
				headers: { token: 'valid' },
				body: {
					webhookId: 'webhook-3',
					url: 'https://example.com/new',
					authToken: 'new-secret',
					format: WebhookFormat.EXTENDED,
					Events: ['PAYMENT_ON_ERROR', 'WALLET_LOW_BALANCE'],
					name: 'Webhook updated',
				},
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockFindExistingWebhook).toHaveBeenCalledWith({
			where: {
				id: { not: 'webhook-3' },
				urlHash: 'hash:https://example.com/new',
				paymentSourceId: 'payment-source-1',
				format: WebhookFormat.EXTENDED,
			},
		});
		expect(mockUpdateWebhook).toHaveBeenCalledWith({
			where: { id: 'webhook-3' },
			data: {
				url: 'enc:https://example.com/new',
				urlHash: 'hash:https://example.com/new',
				authToken: 'enc:new-secret',
				format: WebhookFormat.EXTENDED,
				events: ['PAYMENT_ON_ERROR', 'WALLET_LOW_BALANCE'],
				name: 'Webhook updated',
			},
		});
	});

	it('rejects patching without authToken when format is EXTENDED', async () => {
		const { responseMock } = await testEndpoint({
			endpoint: patchWebhookPatch,
			requestProps: {
				method: 'PATCH',
				headers: { token: 'valid' },
				body: {
					webhookId: 'webhook-3',
					url: 'https://example.com/new',
					format: WebhookFormat.EXTENDED,
					Events: ['PAYMENT_ON_ERROR'],
					name: 'Webhook updated',
				},
			},
		});

		expect(responseMock.statusCode).toBe(400);
		expect(mockUpdateWebhook).not.toHaveBeenCalled();
	});

	it('allows provider webhook patches without authToken', async () => {
		mockFindWebhookById.mockResolvedValue({
			id: 'webhook-4',
			url: 'https://hooks.slack.com/services/old',
			format: WebhookFormat.SLACK,
			authToken: null,
			events: ['PAYMENT_ON_ERROR'],
			name: 'Slack Webhook',
			isActive: true,
			createdAt: new Date('2026-04-08T12:00:00.000Z'),
			updatedAt: new Date('2026-04-08T12:05:00.000Z'),
			paymentSourceId: 'payment-source-1',
			createdByApiKeyId: 'api-key-1',
			PaymentSource: {
				id: 'payment-source-1',
				network: Network.Preprod,
				deletedAt: null,
			},
		});
		mockUpdateWebhook.mockResolvedValue({
			id: 'webhook-4',
			url: 'https://hooks.slack.com/services/new',
			format: WebhookFormat.SLACK,
			authToken: null,
			events: ['PAYMENT_ON_ERROR'],
			name: 'Slack Webhook',
			isActive: true,
			createdAt: new Date('2026-04-08T12:00:00.000Z'),
			updatedAt: new Date('2026-04-08T12:10:00.000Z'),
			paymentSourceId: 'payment-source-1',
		});

		const { responseMock } = await testEndpoint({
			endpoint: patchWebhookPatch,
			requestProps: {
				method: 'PATCH',
				headers: { token: 'valid' },
				body: {
					webhookId: 'webhook-4',
					url: 'https://hooks.slack.com/services/new',
					format: WebhookFormat.SLACK,
					Events: ['PAYMENT_ON_ERROR'],
					name: 'Slack Webhook',
				},
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockUpdateWebhook).toHaveBeenCalledWith({
			where: { id: 'webhook-4' },
			data: {
				url: 'enc:https://hooks.slack.com/services/new',
				urlHash: 'hash:https://hooks.slack.com/services/new',
				authToken: null,
				format: WebhookFormat.SLACK,
				events: ['PAYMENT_ON_ERROR'],
				name: 'Slack Webhook',
			},
		});
	});

	it('rejects patching to a blocked webhook destination', async () => {
		mockAssertWebhookDestinationAllowed.mockRejectedValue(new Error('blocked'));

		const { responseMock } = await testEndpoint({
			endpoint: patchWebhookPatch,
			requestProps: {
				method: 'PATCH',
				headers: { token: 'valid' },
				body: {
					webhookId: 'webhook-4',
					url: 'http://169.254.169.254/latest/meta-data',
					format: WebhookFormat.SLACK,
					Events: ['PAYMENT_ON_ERROR'],
					name: 'Blocked webhook',
				},
			},
		});

		expect(responseMock.statusCode).toBe(400);
		expect(responseMock._getJSONData()).toEqual({
			status: 'error',
			error: { message: 'Webhook destination is not allowed' },
		});
		expect(mockUpdateWebhook).not.toHaveBeenCalled();
	});

	it('rejects patching when the caller is not the creator or an admin', async () => {
		mockFindApiKey.mockResolvedValue({
			...asApiKey(),
			id: 'api-key-2',
			canAdmin: false,
		});
		mockFindWebhookById.mockResolvedValue({
			id: 'webhook-5',
			url: 'https://example.com/old',
			format: WebhookFormat.EXTENDED,
			authToken: 'old-secret',
			events: ['PAYMENT_ON_ERROR'],
			name: 'Webhook',
			isActive: true,
			createdAt: new Date('2026-04-08T12:00:00.000Z'),
			updatedAt: new Date('2026-04-08T12:05:00.000Z'),
			paymentSourceId: 'payment-source-1',
			createdByApiKeyId: 'api-key-1',
			PaymentSource: {
				id: 'payment-source-1',
				network: Network.Preprod,
				deletedAt: null,
			},
		});

		const { responseMock } = await testEndpoint({
			endpoint: patchWebhookPatch,
			requestProps: {
				method: 'PATCH',
				headers: { token: 'valid' },
				body: {
					webhookId: 'webhook-5',
					url: 'https://example.com/new',
					authToken: 'new-secret',
					format: WebhookFormat.EXTENDED,
					Events: ['PAYMENT_ON_ERROR'],
					name: 'Webhook updated',
				},
			},
		});

		expect(responseMock.statusCode).toBe(403);
		expect(mockUpdateWebhook).not.toHaveBeenCalled();
	});

	it('allows the creator to send a test webhook and returns the delivery result', async () => {
		mockFindWebhookById.mockResolvedValue({
			id: 'webhook-test-1',
			url: 'enc:https://hooks.slack.com/services/test',
			format: WebhookFormat.SLACK,
			authToken: null,
			name: 'Slack alerts',
			paymentSourceId: 'payment-source-1',
			createdByApiKeyId: 'api-key-1',
			PaymentSource: {
				id: 'payment-source-1',
				network: Network.Preprod,
				deletedAt: null,
			},
		});

		const { responseMock } = await testEndpoint({
			endpoint: testWebhookPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					webhookId: 'webhook-test-1',
				},
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockSendTestWebhook).toHaveBeenCalledWith(
			{
				id: 'webhook-test-1',
				url: 'enc:https://hooks.slack.com/services/test',
				format: WebhookFormat.SLACK,
				authToken: null,
				name: 'Slack alerts',
				paymentSourceId: 'payment-source-1',
			},
			'api-key-1',
			expect.any(String),
		);
		expect(responseMock._getJSONData()).toEqual({
			status: 'success',
			data: {
				webhookId: 'webhook-test-1',
				success: true,
				responseCode: null,
				errorMessage: null,
				durationMs: 0,
			},
		});
	});

	it('returns a failed test delivery result without throwing when the upstream webhook fails', async () => {
		mockFindWebhookById.mockResolvedValue({
			id: 'webhook-test-2',
			url: 'enc:https://discord.com/api/webhooks/test/token',
			format: WebhookFormat.DISCORD,
			authToken: null,
			name: 'Discord alerts',
			paymentSourceId: 'payment-source-1',
			createdByApiKeyId: 'api-key-1',
			PaymentSource: {
				id: 'payment-source-1',
				network: Network.Preprod,
				deletedAt: null,
			},
		});
		mockSendTestWebhook.mockResolvedValue({
			success: false,
			responseCode: 401,
			errorMessage: 'HTTP 401: Unauthorized',
			durationMs: 98,
		});

		const { responseMock } = await testEndpoint({
			endpoint: testWebhookPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					webhookId: 'webhook-test-2',
				},
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(responseMock._getJSONData()).toEqual({
			status: 'success',
			data: {
				webhookId: 'webhook-test-2',
				success: false,
				responseCode: null,
				errorMessage: 'Delivery failed',
				durationMs: 0,
			},
		});
	});

	it('returns a coarse blocked-by-policy result for test deliveries', async () => {
		mockFindWebhookById.mockResolvedValue({
			id: 'webhook-test-4',
			url: 'enc:http://127.0.0.1/webhook',
			format: WebhookFormat.EXTENDED,
			authToken: 'enc:extended-secret',
			name: 'Blocked relay',
			paymentSourceId: null,
			createdByApiKeyId: 'api-key-1',
			PaymentSource: null,
		});
		mockSendTestWebhook.mockResolvedValue({
			success: false,
			errorMessage: 'Delivery blocked by policy',
			durationMs: 0,
		});

		const { responseMock } = await testEndpoint({
			endpoint: testWebhookPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					webhookId: 'webhook-test-4',
				},
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(responseMock._getJSONData()).toEqual({
			status: 'success',
			data: {
				webhookId: 'webhook-test-4',
				success: false,
				responseCode: null,
				errorMessage: 'Delivery blocked by policy',
				durationMs: 0,
			},
		});
	});

	it('rate limits webhook mutations after 30 requests per minute', async () => {
		mockFindApiKey.mockResolvedValue({
			...asApiKey(),
			id: 'api-key-rate-limit-mutation',
		});
		mockCreateWebhook.mockResolvedValue({
			id: 'webhook-rate-limit',
			url: 'https://example.com/webhooks/masumi',
			format: WebhookFormat.EXTENDED,
			authToken: 'extended-secret',
			events: ['PAYMENT_ON_ERROR'],
			name: 'Rate limit webhook',
			isActive: true,
			createdAt: new Date('2026-04-08T10:00:00.000Z'),
			paymentSourceId: null,
		});

		for (let attempt = 0; attempt < 30; attempt += 1) {
			const { responseMock } = await testEndpoint({
				endpoint: registerWebhookPost,
				requestProps: {
					method: 'POST',
					ip: '198.18.0.10',
					headers: { token: 'valid' },
					body: {
						url: 'https://example.com/webhooks/masumi',
						authToken: 'extended-secret',
						Events: ['PAYMENT_ON_ERROR'],
						name: `Webhook ${attempt}`,
					},
				},
			});

			expect(responseMock.statusCode).toBe(200);
		}

		const { responseMock } = await testEndpoint({
			endpoint: registerWebhookPost,
			requestProps: {
				method: 'POST',
				ip: '198.18.0.10',
				headers: { token: 'valid' },
				body: {
					url: 'https://example.com/webhooks/masumi',
					authToken: 'extended-secret',
					Events: ['PAYMENT_ON_ERROR'],
					name: 'Webhook blocked',
				},
			},
		});

		expect(responseMock.statusCode).toBe(429);
		expect(responseMock._getJSONData()).toEqual({
			status: 'error',
			error: { message: 'Too many requests' },
		});
	});

	it('rate limits webhook tests after 10 requests per minute', async () => {
		mockFindApiKey.mockResolvedValue({
			...asApiKey(),
			id: 'api-key-rate-limit-test',
		});
		mockFindWebhookById.mockResolvedValue({
			id: 'webhook-rate-limit-test',
			url: 'enc:https://hooks.slack.com/services/test',
			format: WebhookFormat.SLACK,
			authToken: null,
			name: 'Slack alerts',
			paymentSourceId: null,
			createdByApiKeyId: 'api-key-rate-limit-test',
			PaymentSource: null,
		});
		mockSendTestWebhook.mockResolvedValue({
			success: true,
			responseCode: 200,
			durationMs: 120,
		});

		for (let attempt = 0; attempt < 10; attempt += 1) {
			const { responseMock } = await testEndpoint({
				endpoint: testWebhookPost,
				requestProps: {
					method: 'POST',
					ip: '198.18.0.11',
					headers: { token: 'valid' },
					body: {
						webhookId: 'webhook-rate-limit-test',
					},
				},
			});

			expect(responseMock.statusCode).toBe(200);
		}

		const { responseMock } = await testEndpoint({
			endpoint: testWebhookPost,
			requestProps: {
				method: 'POST',
				ip: '198.18.0.11',
				headers: { token: 'valid' },
				body: {
					webhookId: 'webhook-rate-limit-test',
				},
			},
		});

		expect(responseMock.statusCode).toBe(429);
		expect(responseMock._getJSONData()).toEqual({
			status: 'error',
			error: { message: 'Too many requests' },
		});
	});

	it('rejects test sends when the caller is not the creator or an admin', async () => {
		mockFindWebhookById.mockResolvedValue({
			id: 'webhook-test-3',
			url: 'enc:https://example.com/webhook',
			format: WebhookFormat.EXTENDED,
			authToken: 'enc:extended-secret',
			name: 'External relay',
			paymentSourceId: null,
			createdByApiKeyId: 'another-api-key',
			PaymentSource: null,
		});
		mockFindApiKey.mockResolvedValue({
			...asApiKey(),
			canAdmin: false,
		});

		const { responseMock } = await testEndpoint({
			endpoint: testWebhookPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					webhookId: 'webhook-test-3',
				},
			},
		});

		expect(responseMock.statusCode).toBe(403);
		expect(mockSendTestWebhook).not.toHaveBeenCalled();
	});
});
