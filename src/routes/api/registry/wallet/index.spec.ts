import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { testEndpoint } from 'express-zod-api';
import { ApiKeyStatus, Network, PricingType } from '@/generated/prisma/enums';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindApiKey = jest.fn() as AnyMock;
const mockFindPaymentSource = jest.fn() as AnyMock;
const mockAddresses = jest.fn() as AnyMock;
const mockAccountsAddressesAssetsAll = jest.fn() as AnyMock;
const mockAssetsById = jest.fn() as AnyMock;
const mockGetRegistryScript = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		apiKey: {
			findUnique: mockFindApiKey,
		},
		paymentSource: {
			findUnique: mockFindPaymentSource,
		},
	},
}));

jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONFIG: {
		ENCRYPTION_KEY: '12345678901234567890',
	},
	DEFAULTS: {
		PAYMENT_SMART_CONTRACT_ADDRESS_MAINNET: 'addr1default',
		PAYMENT_SMART_CONTRACT_ADDRESS_PREPROD: 'addr_test1default',
		DEFAULT_IMAGE: 'ipfs://image',
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

jest.unstable_mockModule('@/utils/blockfrost', () => ({
	getBlockfrostInstance: jest.fn(() => ({
		addresses: mockAddresses,
		accountsAddressesAssetsAll: mockAccountsAddressesAssetsAll,
		assetsById: mockAssetsById,
	})),
}));

jest.unstable_mockModule('@/utils/generator/contract-generator', () => ({
	getRegistryScriptFromNetworkHandler: mockGetRegistryScript,
	getRegistryScriptFromNetworkHandlerV1: mockGetRegistryScript,
}));

jest.unstable_mockModule('@/generated/prisma/client', async () => await import('@/generated/prisma/enums'));

const { queryAgentFromWalletGet } = await import('./index');

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

describe('queryAgentFromWalletGet', () => {
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
				name: 'Recipient-held agent',
				description: 'Agent description',
				api_base_url: 'https://example.com/agent',
				example_output: [],
				author: {
					name: 'Author',
				},
				tags: ['demo'],
				agentPricing: {
					pricingType: PricingType.Free,
				},
				image: 'ipfs://image',
				metadata_version: 1,
			},
		});
	});

	it('allows querying assets for a managed non-selling wallet', async () => {
		const { responseMock } = await testEndpoint({
			endpoint: queryAgentFromWalletGet,
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
					name: 'Recipient-held agent',
				}),
			}),
		]);
	});
	it('preserves on-chain payment source positions for metadata with multiple networks', async () => {
		mockAssetsById.mockResolvedValue({
			onchain_metadata: {
				name: 'External agent',
				api_base_url: 'https://example.com/agent',
				author: { name: 'Author' },
				tags: ['demo'],
				image: 'ipfs://image',
				metadata_version: 2,
				supported_payment_sources: [Network.Mainnet, Network.Preprod].map((network) => ({
					chain: 'Cardano',
					network,
					settlement: {
						paymentSourceType: 'Web3CardanoV2',
						address:
							network === Network.Mainnet
								? 'addr1w859pcn45l8mc85s65cjk6t56mk0evgp9wjlpyht3k42wwc3hq2df'
								: 'addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g',
					},
					pricing: { pricingType: PricingType.Free },
				})),
			},
		});

		const { responseMock } = await testEndpoint({
			endpoint: queryAgentFromWalletGet,
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
		expect(responseMock._getJSONData().data.Assets[0].Metadata.supportedPaymentSources).toEqual([
			expect.objectContaining({ network: Network.Mainnet }),
			expect.objectContaining({ network: Network.Preprod }),
		]);
	});
});
