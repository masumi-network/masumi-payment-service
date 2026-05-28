import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { testEndpoint } from 'express-zod-api';
import { ApiKeyStatus, Network, PricingType, RegistrationState } from '@/generated/prisma/enums';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindApiKey = jest.fn() as AnyMock;
const mockFindPaymentSource = jest.fn() as AnyMock;
const mockFindRegistryRequest = jest.fn() as AnyMock;
const mockUpdateRegistryRequest = jest.fn() as AnyMock;
const mockAssetsAddresses = jest.fn() as AnyMock;
const mockResolvePaymentKeyHash = jest.fn() as AnyMock;
const mockGetRegistryScript = jest.fn() as AnyMock;
const mockGetRegistryScriptV2 = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		apiKey: {
			findUnique: mockFindApiKey,
		},
		paymentSource: {
			findUnique: mockFindPaymentSource,
			findFirst: mockFindPaymentSource,
		},
		registryRequest: {
			findUnique: mockFindRegistryRequest,
			update: mockUpdateRegistryRequest,
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
	},
	SERVICE_CONSTANTS: {
		SMART_CONTRACT: {
			collateralAmount: '5000000',
		},
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
		assetsAddresses: mockAssetsAddresses,
	})),
	validateAssetsOnChain: jest.fn(),
}));

jest.unstable_mockModule('@/utils/generator/contract-generator', () => ({
	getRegistryScriptFromNetworkHandler: mockGetRegistryScript,
	getRegistryScriptFromNetworkHandlerV1: mockGetRegistryScript,
	getRegistryScriptFromNetworkHandlerV2: mockGetRegistryScriptV2,
}));

jest.unstable_mockModule('@meshsdk/core-cst', () => ({
	AddressType: {
		BasePaymentKeyStakeKey: 0,
	},
	deserializeAddress: jest.fn(() => ({
		getType: () => 0,
		pubKeyHash: 'payment-key-hash',
		stakeCredentialHash: 'stake-key-hash',
	})),
	resolvePaymentKeyHash: mockResolvePaymentKeyHash,
	resolveStakeKeyHash: jest.fn(() => 'stake-key-hash'),
}));

jest.unstable_mockModule('@/generated/prisma/client', async () => await import('@/generated/prisma/enums'));

jest.unstable_mockModule('@prisma/client', async () => ({
	...(await import('@/generated/prisma/enums')),
	OnChainState: {
		FundsLocked: 'FundsLocked',
		FundsOrDatumInvalid: 'FundsOrDatumInvalid',
		ResultSubmitted: 'ResultSubmitted',
		RefundRequested: 'RefundRequested',
		Disputed: 'Disputed',
		WithdrawAuthorized: 'WithdrawAuthorized',
		RefundAuthorized: 'RefundAuthorized',
		Withdrawn: 'Withdrawn',
		RefundWithdrawn: 'RefundWithdrawn',
		DisputedWithdrawn: 'DisputedWithdrawn',
	},
}));

const { unregisterAgentPost } = await import('./index');

function asApiKey() {
	return {
		id: 'api-key-1',
		canRead: true,
		canPay: true,
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

function buildRegistryUpdateResponse() {
	return {
		id: 'registry-request-1',
		error: null,
		name: 'Test Agent',
		description: 'Agent description',
		apiBaseUrl: 'https://example.com/agent',
		capabilityName: 'demo',
		capabilityVersion: '1.0.0',
		authorName: 'Author',
		authorContactEmail: 'author@example.com',
		authorContactOther: null,
		authorOrganization: null,
		privacyPolicy: null,
		terms: null,
		other: null,
		state: RegistrationState.DeregistrationRequested,
		tags: ['demo'],
		createdAt: new Date('2026-04-12T10:00:00.000Z'),
		updatedAt: new Date('2026-04-12T10:00:00.000Z'),
		lastCheckedAt: null,
		agentIdentifier: 'a'.repeat(56) + 'a55e7',
		ExampleOutputs: [],
		Pricing: {
			pricingType: PricingType.Free,
			FixedPricing: null,
		},
		sendFundingLovelace: BigInt(7_500_000),
		SmartContractWallet: {
			walletVkey: 'selling-wallet-vkey',
			walletAddress: 'addr_test1sellingwallet',
		},
		RecipientWallet: {
			walletVkey: 'recipient-wallet-vkey',
			walletAddress: 'addr_test1recipientwallet',
		},
		SupportedPaymentSources: [],
		CurrentTransaction: null,
	};
}

describe('unregisterAgentPost', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockFindApiKey.mockResolvedValue(asApiKey());
		mockGetRegistryScript.mockResolvedValue({ policyId: 'a'.repeat(56) });
		mockResolvePaymentKeyHash.mockImplementation((address: string) => {
			if (address === 'addr_test1recipientwallet') {
				return 'recipient-wallet-vkey';
			}
			return 'unknown-wallet-vkey';
		});
		mockAssetsAddresses.mockResolvedValue([
			{
				address: 'addr_test1recipientwallet',
				quantity: '1',
			},
		]);
		mockFindPaymentSource.mockResolvedValue({
			id: 'payment-source-1',
			network: Network.Preprod,
			paymentSourceType: 'Web3CardanoV1',
			PaymentSourceConfig: {
				rpcProviderApiKey: 'provider-key',
			},
			HotWallets: [
				{
					id: 'selling-wallet-id',
					walletVkey: 'selling-wallet-vkey',
					walletAddress: 'addr_test1sellingwallet',
				},
				{
					id: 'recipient-wallet-id',
					walletVkey: 'recipient-wallet-vkey',
					walletAddress: 'addr_test1recipientwallet',
				},
			],
		});
		mockFindRegistryRequest.mockResolvedValue({
			id: 'registry-request-1',
		});
		mockUpdateRegistryRequest.mockResolvedValue(buildRegistryUpdateResponse());
	});

	it('uses the current managed holder wallet for deregistration requests', async () => {
		const { responseMock } = await testEndpoint({
			endpoint: unregisterAgentPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					agentIdentifier: 'a'.repeat(56) + 'a55e7',
					network: Network.Preprod,
				},
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockFindPaymentSource.mock.calls[0]?.[0]?.where).toEqual({
			network: Network.Preprod,
			policyId: 'a'.repeat(56),
			deletedAt: null,
		});
		expect(mockUpdateRegistryRequest.mock.calls[0]?.[0]?.data).toEqual({
			state: RegistrationState.DeregistrationRequested,
			deregistrationHotWalletId: 'recipient-wallet-id',
		});
		expect(responseMock._getJSONData().data.RecipientWallet).toEqual({
			walletVkey: 'recipient-wallet-vkey',
			walletAddress: 'addr_test1recipientwallet',
		});
		expect(responseMock._getJSONData().data.sendFundingLovelace).toBe('7500000');
	});

	it('falls back to the default source address when policy lookup misses', async () => {
		mockFindPaymentSource.mockResolvedValueOnce(null);

		const { responseMock } = await testEndpoint({
			endpoint: unregisterAgentPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					agentIdentifier: 'a'.repeat(56) + 'a55e7',
					network: Network.Preprod,
				},
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockFindPaymentSource.mock.calls[0]?.[0]?.where).toEqual({
			network: Network.Preprod,
			policyId: 'a'.repeat(56),
			deletedAt: null,
		});
		expect(mockFindPaymentSource.mock.calls[1]?.[0]?.where).toEqual({
			network_smartContractAddress: {
				network: Network.Preprod,
				smartContractAddress: 'addr_test1default',
			},
			deletedAt: null,
		});
	});

	it('returns 409 when the asset is no longer held by a managed wallet', async () => {
		mockFindPaymentSource.mockResolvedValue({
			id: 'payment-source-1',
			network: Network.Preprod,
			PaymentSourceConfig: {
				rpcProviderApiKey: 'provider-key',
			},
			HotWallets: [
				{
					id: 'selling-wallet-id',
					walletVkey: 'selling-wallet-vkey',
					walletAddress: 'addr_test1sellingwallet',
				},
			],
		});

		const { responseMock } = await testEndpoint({
			endpoint: unregisterAgentPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					agentIdentifier: 'a'.repeat(56) + 'a55e7',
					network: Network.Preprod,
				},
			},
		});

		expect(responseMock.statusCode).toBe(409);
		expect(mockUpdateRegistryRequest).not.toHaveBeenCalled();
	});
});
