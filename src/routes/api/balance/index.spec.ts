import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { testEndpoint } from 'express-zod-api';
import { ApiKeyStatus, Network } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindApiKey = jest.fn() as AnyMock;
const mockFindPaymentSource = jest.fn() as AnyMock;
const mockFetchAddressBalance = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		apiKey: {
			findUnique: mockFindApiKey,
		},
		paymentSource: {
			findFirst: mockFindPaymentSource,
		},
	},
}));

jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONFIG: {
		ENCRYPTION_KEY: '12345678901234567890',
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

jest.unstable_mockModule('@/services/shared/address-balance', () => ({
	fetchAddressBalance: mockFetchAddressBalance,
}));

const { queryBalanceEndpointGet } = await import('./index');

function asApiKey(networkLimit: Network[] = [Network.Preprod]) {
	return {
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
	};
}

describe('queryBalanceEndpointGet', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockFindApiKey.mockResolvedValue(asApiKey());
		mockFindPaymentSource.mockResolvedValue({
			id: 'payment-source-1',
			PaymentSourceConfig: {
				rpcProviderApiKey: 'provider-key',
			},
		});
	});

	it('returns the complete confirmed address balance with numeric quantities', async () => {
		mockFetchAddressBalance.mockResolvedValue([
			{ unit: 'lovelace', quantity: '42000000' },
			{ unit: 'asset-unit', quantity: '1009494700' },
		]);

		const { responseMock } = await testEndpoint({
			endpoint: queryBalanceEndpointGet,
			requestProps: {
				method: 'GET',
				headers: { token: 'valid' },
				query: {
					address: 'addr_test1wallet',
					network: Network.Preprod,
				},
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockFetchAddressBalance).toHaveBeenCalledWith({
			network: Network.Preprod,
			rpcProviderApiKey: 'provider-key',
			address: 'addr_test1wallet',
		});
		expect(responseMock._getJSONData()).toEqual({
			status: 'success',
			data: {
				Balance: [
					{ unit: 'lovelace', quantity: 42000000 },
					{ unit: 'asset-unit', quantity: 1009494700 },
				],
			},
		});
	});

	it('selects the Mainnet provider and balance when Mainnet is requested', async () => {
		mockFindApiKey.mockResolvedValue(asApiKey([Network.Mainnet]));
		mockFindPaymentSource.mockResolvedValue({
			id: 'mainnet-payment-source',
			PaymentSourceConfig: {
				rpcProviderApiKey: 'mainnet-provider-key',
			},
		});
		mockFetchAddressBalance.mockResolvedValue([{ unit: 'lovelace', quantity: '9000000' }]);

		const { responseMock } = await testEndpoint({
			endpoint: queryBalanceEndpointGet,
			requestProps: {
				method: 'GET',
				headers: { token: 'valid' },
				query: {
					address: 'addr1wallet',
					network: Network.Mainnet,
				},
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockFindPaymentSource).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					network: Network.Mainnet,
					deletedAt: null,
				},
			}),
		);
		expect(mockFetchAddressBalance).toHaveBeenCalledWith({
			network: Network.Mainnet,
			rpcProviderApiKey: 'mainnet-provider-key',
			address: 'addr1wallet',
		});
	});

	it('returns an empty balance for an unused address', async () => {
		mockFetchAddressBalance.mockResolvedValue([]);

		const { responseMock } = await testEndpoint({
			endpoint: queryBalanceEndpointGet,
			requestProps: {
				method: 'GET',
				headers: { token: 'valid' },
				query: {
					address: 'addr_test1unused',
					network: Network.Preprod,
				},
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(responseMock._getJSONData()).toEqual({
			status: 'success',
			data: {
				Balance: [],
			},
		});
	});

	it('does not turn provider failures into a zero balance', async () => {
		mockFetchAddressBalance.mockRejectedValue(new Error('provider unavailable'));

		const { responseMock } = await testEndpoint({
			endpoint: queryBalanceEndpointGet,
			requestProps: {
				method: 'GET',
				headers: { token: 'valid' },
				query: {
					address: 'addr_test1wallet',
					network: Network.Preprod,
				},
			},
		});

		expect(responseMock.statusCode).toBe(500);
		expect(responseMock._getJSONData()).toEqual({
			status: 'error',
			error: {
				message: 'Failed to get address balance',
			},
		});
	});
});
