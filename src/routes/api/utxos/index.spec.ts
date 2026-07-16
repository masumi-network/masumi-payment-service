import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { testEndpoint } from 'express-zod-api';
import { ApiKeyStatus, Network } from '@/generated/prisma/enums';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindApiKey = jest.fn() as AnyMock;
const mockFindPaymentSource = jest.fn() as AnyMock;
const mockAddressesUtxos = jest.fn() as AnyMock;

jest.unstable_mockModule('@/utils/db', () => ({
	prisma: {
		apiKey: {
			findUnique: mockFindApiKey,
		},
		paymentSource: {
			findFirst: mockFindPaymentSource,
		},
	},
}));

jest.unstable_mockModule('@/utils/config', () => ({
	CONFIG: {
		ENCRYPTION_KEY: '12345678901234567890',
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

jest.unstable_mockModule('@/utils/blockfrost', () => ({
	getBlockfrostInstance: jest.fn(() => ({
		addressesUtxos: mockAddressesUtxos,
	})),
}));

jest.unstable_mockModule('@/generated/prisma/client', async () => await import('@/generated/prisma/enums'));

const { queryUTXOEndpointGet } = await import('./index');

function asApiKey() {
	return {
		id: 'api-key-1',
		canRead: true,
		canPay: false,
		canAdmin: false,
		status: ApiKeyStatus.Active,
		token: null,
		tokenHash: null,
		usageLimited: false,
		networkLimit: [Network.Preprod],
		walletScopeEnabled: false,
		WalletScopes: [],
	};
}

describe('queryUTXOEndpointGet', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockFindApiKey.mockResolvedValue(asApiKey());
		mockFindPaymentSource.mockResolvedValue({
			id: 'payment-source-1',
			PaymentSourceConfig: {
				rpcProviderApiKey: 'provider-key',
			},
		});
		mockAddressesUtxos.mockResolvedValue([
			{
				tx_hash: 'tx-hash',
				address: 'addr_test1wallet',
				amount: [{ unit: 'lovelace', quantity: '2000000' }],
				output_index: 0,
				block: 'block-hash',
				data_hash: null,
				inline_datum: null,
				reference_script_hash: null,
			},
		]);
	});

	it('keeps the existing paginated numeric UTXO response unchanged', async () => {
		const { responseMock } = await testEndpoint({
			endpoint: queryUTXOEndpointGet,
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
		expect(mockAddressesUtxos).toHaveBeenCalledWith('addr_test1wallet', {
			count: 10,
			page: 1,
			order: 'desc',
		});
		expect(responseMock._getJSONData()).toEqual({
			status: 'success',
			data: {
				Utxos: [
					expect.objectContaining({
						txHash: 'tx-hash',
						Amounts: [{ unit: 'lovelace', quantity: 2000000 }],
					}),
				],
			},
		});
	});
});
