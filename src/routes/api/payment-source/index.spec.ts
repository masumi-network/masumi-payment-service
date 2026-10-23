import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { testEndpoint } from 'express-zod-api';
import { ApiKeyStatus, Network } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindApiKey = jest.fn() as AnyMock;
const mockFindManyPaymentSources = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		apiKey: { findUnique: mockFindApiKey },
		paymentSource: { findMany: mockFindManyPaymentSources },
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { paymentSourceEndpointGet } = await import('./index');

const asApiKey = (networkLimit: Network[]) => ({
	id: 'api-key-1',
	canRead: true,
	canPay: false,
	canAdmin: false,
	status: ApiKeyStatus.Active,
	token: null,
	tokenHash: null,
	tokenHashSecure: 'pbkdf2-placeholder',
	usageLimited: false,
	networkLimit,
	walletScopeEnabled: false,
	WalletScopes: [],
});

describe('paymentSourceEndpointGet filterNetwork', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockFindManyPaymentSources.mockResolvedValue([]);
	});

	it('returns 401 when filterNetwork is outside the API key network limit', async () => {
		mockFindApiKey.mockResolvedValue(asApiKey([Network.Preprod]));

		const { responseMock } = await testEndpoint({
			endpoint: paymentSourceEndpointGet,
			requestProps: {
				method: 'GET',
				headers: { token: 'valid' },
				query: { filterNetwork: Network.Mainnet },
			},
		});

		expect(responseMock.statusCode).toBe(401);
		expect(mockFindManyPaymentSources).not.toHaveBeenCalled();
	});

	it('lists sources when filterNetwork is allowed', async () => {
		mockFindApiKey.mockResolvedValue(asApiKey([Network.Preprod, Network.Mainnet]));

		const { responseMock } = await testEndpoint({
			endpoint: paymentSourceEndpointGet,
			requestProps: {
				method: 'GET',
				headers: { token: 'valid' },
				query: { filterNetwork: Network.Preprod },
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockFindManyPaymentSources).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					network: { in: [Network.Preprod] },
				}),
			}),
		);
	});
});
