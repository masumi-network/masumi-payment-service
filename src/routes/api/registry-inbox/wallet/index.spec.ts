import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { testEndpoint } from 'express-zod-api';
import { ApiKeyStatus, Network } from '@/generated/prisma/enums';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindApiKey = jest.fn() as AnyMock;
const mockFindPaymentSource = jest.fn() as AnyMock;
const mockAddresses = jest.fn() as AnyMock;
const mockAccountsAddressesAssetsAll = jest.fn() as AnyMock;
const mockAssetsById = jest.fn() as AnyMock;
const mockGetRegistryScript = jest.fn() as AnyMock;

jest.unstable_mockModule('@/utils/db', () => ({
	prisma: {
		apiKey: {
			findUnique: mockFindApiKey,
		},
		paymentSource: {
			findUnique: mockFindPaymentSource,
		},
	},
}));

jest.unstable_mockModule('@/utils/config', () => ({
	CONFIG: {
		ENCRYPTION_KEY: '12345678901234567890',
	},
	DEFAULTS: {
		PAYMENT_SMART_CONTRACT_ADDRESS_MAINNET: 'addr1default',
		PAYMENT_SMART_CONTRACT_ADDRESS_PREPROD: 'addr_test1default',
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
		addresses: mockAddresses,
		accountsAddressesAssetsAll: mockAccountsAddressesAssetsAll,
		assetsById: mockAssetsById,
	})),
}));

jest.unstable_mockModule('@/utils/generator/contract-generator', () => ({
	getRegistryScriptFromNetworkHandlerV1: mockGetRegistryScript,
}));

jest.unstable_mockModule('@/generated/prisma/client', async () => await import('@/generated/prisma/enums'));

const { queryInboxAgentFromWalletGet } = await import('./index');

function asApiKey() {
	return {
		id: 'api-key-1',
		canRead: true,
		canPay: false,
		canAdmin: true,
		status: ApiKeyStatus.Active,
		token: null,
		tokenHash: null,
		usageLimited: false,
		networkLimit: [],
		walletScopeEnabled: false,
		WalletScopes: [],
	};
}

describe('queryInboxAgentFromWalletGet', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockFindApiKey.mockResolvedValue(asApiKey());
		mockGetRegistryScript.mockResolvedValue({ policyId: 'p'.repeat(56) });
		mockFindPaymentSource.mockResolvedValue({
			id: 'payment-source-1',
			PaymentSourceConfig: {
				rpcProviderApiKey: 'provider-key',
			},
			HotWallets: [
				{
					id: 'recipient-wallet-id',
					walletVkey: 'recipient-wallet-vkey',
					walletAddress: 'addr_test1recipientwallet',
					type: 'Purchasing',
				},
			],
		});
		mockAddresses.mockResolvedValue({
			stake_address: 'stake_test1recipient',
		});
		mockAccountsAddressesAssetsAll.mockResolvedValue([
			{
				unit: 'p'.repeat(56) + 'asset',
			},
		]);
		mockAssetsById.mockResolvedValue({
			onchain_metadata: {
				name: 'Inbox Agent',
				description: 'Inbox description',
				agentslug: 'inbox-agent',
				metadata_version: 1,
			},
		});
	});

	it('allows querying inbox assets for a managed non-selling wallet', async () => {
		const { responseMock } = await testEndpoint({
			endpoint: queryInboxAgentFromWalletGet,
			requestProps: {
				method: 'GET',
				headers: { token: 'valid' },
				query: {
					walletVkey: 'recipient-wallet-vkey',
					network: Network.Preprod,
				},
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(responseMock._getJSONData().data.Assets).toEqual([
			expect.objectContaining({
				agentIdentifier: 'p'.repeat(56) + 'asset',
				Metadata: expect.objectContaining({
					name: 'Inbox Agent',
					agentSlug: 'inbox-agent',
				}),
			}),
		]);
	});
});
