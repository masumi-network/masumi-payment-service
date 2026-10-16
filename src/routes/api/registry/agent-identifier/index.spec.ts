import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { testEndpoint } from 'express-zod-api';
import { ApiKeyStatus, Network, PaymentSourceType } from '@/generated/prisma/enums';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindApiKey = jest.fn() as AnyMock;
const mockFindPaymentSource = jest.fn() as AnyMock;
const mockFindRegistryRequest = jest.fn() as AnyMock;
const mockGetBlockfrostInstance = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		apiKey: {
			findUnique: mockFindApiKey,
		},
		paymentSource: {
			findFirst: mockFindPaymentSource,
		},
		registryRequest: {
			findFirst: mockFindRegistryRequest,
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
	getBlockfrostInstance: mockGetBlockfrostInstance,
}));

jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONFIG: {
		DATABASE_URL: 'postgresql://test',
		ENCRYPTION_KEY: '123456789012345678901',
	},
	DEFAULTS: {
		PAYMENT_SMART_CONTRACT_ADDRESS_MAINNET: 'addr_main1test',
		PAYMENT_SMART_CONTRACT_ADDRESS_PREPROD: 'addr_test1test',
	},
	CONSTANTS: {},
	SERVICE_CONSTANTS: {
		SMART_CONTRACT: {
			collateralAmount: '5000000',
		},
	},
}));

jest.unstable_mockModule('@/utils/generator/contract-generator', () => ({
	getRegistryScriptFromNetworkHandler: jest.fn(),
	getRegistryScriptFromNetworkHandlerV1: jest.fn(),
}));

const { queryAgentByIdentifierGet } = await import('./index');
const validAgentIdentifier = 'ab'.repeat(29);

function asApiKey(walletScopeIds: string[] | null = null) {
	return {
		id: 'api-key-1',
		canRead: true,
		canPay: true,
		canAdmin: walletScopeIds == null,
		status: ApiKeyStatus.Active,
		token: null,
		tokenHash: null,
		usageLimited: false,
		networkLimit: walletScopeIds == null ? [] : [Network.Preprod],
		walletScopeEnabled: walletScopeIds != null,
		WalletScopes: (walletScopeIds ?? []).map((hotWalletId) => ({ hotWalletId })),
	};
}

describe('queryAgentByIdentifierGet', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockFindApiKey.mockResolvedValue(asApiKey(['holding-wallet-id']));
		mockFindPaymentSource.mockResolvedValue({
			id: 'payment-source-1',
			PaymentSourceConfig: { rpcProviderApiKey: 'provider-key' },
		});
		mockFindRegistryRequest.mockResolvedValue(null);
	});

	it.each([PaymentSourceType.Web3CardanoV1, PaymentSourceType.Web3CardanoV2])(
		'limits A2A identifier metadata to V2 policies (%s)',
		async (paymentSourceType) => {
			mockFindApiKey.mockResolvedValue(asApiKey());
			mockFindPaymentSource.mockResolvedValue({
				id: 'payment-source-1',
				paymentSourceType,
				PaymentSourceConfig: { rpcProviderApiKey: 'provider-key' },
			});
			mockGetBlockfrostInstance.mockReturnValue({
				assetsById: jest.fn(async () => ({
					onchain_metadata: {
						name: 'A2A',
						type: 'a2aV1',
						api_url: 'https://agent.example/a2a',
						agent_card_url: 'https://agent.example/card',
						a2a_protocol_versions: ['1.0'],
						author: { name: 'Author' },
						tags: ['ai'],
						image: 'ipfs://image',
						metadata_version: 2,
					},
				})),
			});
			const { responseMock } = await testEndpoint({
				endpoint: queryAgentByIdentifierGet,
				requestProps: {
					method: 'GET',
					headers: { token: 'valid' },
					query: { network: Network.Preprod, agentIdentifier: validAgentIdentifier },
				},
			});
			expect(responseMock.statusCode).toBe(paymentSourceType === PaymentSourceType.Web3CardanoV2 ? 200 : 422);
			if (paymentSourceType === PaymentSourceType.Web3CardanoV1)
				expect(JSON.stringify(responseMock._getJSONData())).toContain('Agent metadata is invalid or malformed');
		},
	);

	it('rejects wallet-scoped lookups for agents not owned by the scoped holder wallet', async () => {
		const { responseMock } = await testEndpoint({
			endpoint: queryAgentByIdentifierGet,
			requestProps: {
				method: 'GET',
				headers: { token: 'valid' },
				query: {
					network: Network.Preprod,
					agentIdentifier: validAgentIdentifier,
				},
			},
		});

		expect(responseMock.statusCode).toBe(404);
		expect(mockFindRegistryRequest).toHaveBeenCalledWith({
			where: {
				agentIdentifier: validAgentIdentifier,
				PaymentSource: {
					network: Network.Preprod,
					deletedAt: null,
				},
				SmartContractWallet: {
					deletedAt: null,
				},
				AND: [
					{
						OR: [
							{ deregistrationHotWalletId: { in: ['holding-wallet-id'] } },
							{
								deregistrationHotWalletId: null,
								recipientHotWalletId: { in: ['holding-wallet-id'] },
							},
							{
								deregistrationHotWalletId: null,
								recipientHotWalletId: null,
								smartContractWalletId: { in: ['holding-wallet-id'] },
							},
						],
					},
				],
			},
			select: {
				id: true,
			},
		});
		expect(mockGetBlockfrostInstance).not.toHaveBeenCalled();
	});
});
