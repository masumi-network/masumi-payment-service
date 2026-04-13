import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { testEndpoint } from 'express-zod-api';
import { ApiKeyStatus, Network, PricingType, RegistrationState } from '@/generated/prisma/enums';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindApiKey = jest.fn() as AnyMock;
const mockFindSellingWallet = jest.fn() as AnyMock;
const mockFindRecipientWallet = jest.fn() as AnyMock;
const mockCreateRegistryRequest = jest.fn() as AnyMock;
const mockFindRegistryRequests = jest.fn() as AnyMock;
const mockCountRegistryRequests = jest.fn() as AnyMock;

jest.unstable_mockModule('@/utils/db', () => ({
	prisma: {
		apiKey: {
			findUnique: mockFindApiKey,
		},
		hotWallet: {
			findUnique: mockFindSellingWallet,
			findFirst: mockFindRecipientWallet,
		},
		registryRequest: {
			create: mockCreateRegistryRequest,
			count: mockCountRegistryRequests,
			findMany: mockFindRegistryRequests,
			findUnique: jest.fn(),
			delete: jest.fn(),
		},
	},
}));

jest.unstable_mockModule('@/utils/config', () => ({
	CONFIG: {
		ENCRYPTION_KEY: '12345678901234567890',
	},
	DEFAULTS: {
		DEFAULT_METADATA_VERSION: 1,
	},
	SERVICE_CONSTANTS: {
		SMART_CONTRACT: {
			collateralAmount: '5000000',
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

jest.unstable_mockModule('@/utils/metrics', () => ({
	recordBusinessEndpointError: jest.fn(),
}));

jest.unstable_mockModule('@/utils/blockfrost', () => ({
	getBlockfrostInstance: jest.fn(),
	validateAssetsOnChain: jest.fn(),
}));

jest.unstable_mockModule('@/generated/prisma/client', async () => await import('@/generated/prisma/enums'));

jest.unstable_mockModule('@prisma/client', () => ({
	OnChainState: {
		FundsLocked: 'FundsLocked',
		FundsOrDatumInvalid: 'FundsOrDatumInvalid',
		ResultSubmitted: 'ResultSubmitted',
		RefundRequested: 'RefundRequested',
		Disputed: 'Disputed',
		Withdrawn: 'Withdrawn',
		RefundWithdrawn: 'RefundWithdrawn',
		DisputedWithdrawn: 'DisputedWithdrawn',
	},
}));

const { queryRegistryRequestGet, queryRegistryCountGet, registerAgentPost } = await import('./index');

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

function buildSellingWallet() {
	return {
		id: 'selling-wallet-id',
		paymentSourceId: 'payment-source-1',
		walletVkey: 'selling-wallet-vkey',
		walletAddress: 'addr_test1sellingwallet',
		PaymentSource: {
			PaymentSourceConfig: {
				rpcProviderApiKey: 'provider-key',
			},
		},
	};
}

function buildRegistryRequestResponse(
	recipientWallet: { walletVkey: string; walletAddress: string } | null,
	sendFundingLovelace: bigint | null = null,
) {
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
		state: RegistrationState.RegistrationRequested,
		tags: ['demo'],
		createdAt: new Date('2026-04-12T10:00:00.000Z'),
		updatedAt: new Date('2026-04-12T10:00:00.000Z'),
		lastCheckedAt: null,
		agentIdentifier: null,
		ExampleOutputs: [],
		Pricing: {
			pricingType: PricingType.Free,
			FixedPricing: null,
		},
		sendFundingLovelace,
		SmartContractWallet: {
			walletVkey: 'selling-wallet-vkey',
			walletAddress: 'addr_test1sellingwallet',
		},
		RecipientWallet: recipientWallet,
		CurrentTransaction: null,
	};
}

describe('registerAgentPost', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockFindApiKey.mockResolvedValue(asApiKey());
		mockFindSellingWallet.mockResolvedValue(buildSellingWallet());
		mockFindRecipientWallet.mockResolvedValue(null);
		mockCreateRegistryRequest.mockResolvedValue(buildRegistryRequestResponse(null));
		mockFindRegistryRequests.mockResolvedValue([]);
		mockCountRegistryRequests.mockResolvedValue(0);
	});

	it('scopes registry list queries to the current managed holder wallet', async () => {
		mockFindApiKey.mockResolvedValue(asApiKey(['holding-wallet-id']));

		const { responseMock } = await testEndpoint({
			endpoint: queryRegistryRequestGet,
			requestProps: {
				method: 'GET',
				headers: { token: 'valid' },
				query: {
					network: Network.Preprod,
					limit: '10',
				},
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockFindRegistryRequests).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
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
				}),
			}),
		);
	});

	it('scopes registry counts to the current managed holder wallet', async () => {
		mockFindApiKey.mockResolvedValue(asApiKey(['holding-wallet-id']));

		const { responseMock } = await testEndpoint({
			endpoint: queryRegistryCountGet,
			requestProps: {
				method: 'GET',
				headers: { token: 'valid' },
				query: {
					network: Network.Preprod,
				},
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockCountRegistryRequests).toHaveBeenCalledWith({
			where: {
				PaymentSource: {
					network: Network.Preprod,
					deletedAt: null,
					smartContractAddress: undefined,
				},
				SmartContractWallet: { deletedAt: null },
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
		});
	});

	it('keeps the current flow when no recipient wallet is provided', async () => {
		const { responseMock } = await testEndpoint({
			endpoint: registerAgentPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					network: Network.Preprod,
					sellingWalletVkey: 'selling-wallet-vkey',
					name: 'Test Agent',
					description: 'Agent description',
					apiBaseUrl: 'https://example.com/agent',
					Tags: ['demo'],
					Capability: {
						name: 'demo',
						version: '1.0.0',
					},
					AgentPricing: {
						pricingType: PricingType.Free,
					},
					Author: {
						name: 'Author',
					},
					ExampleOutputs: [],
				},
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockFindRecipientWallet).not.toHaveBeenCalled();
		expect(mockCreateRegistryRequest.mock.calls[0]?.[0]?.data?.RecipientWallet).toBeUndefined();
		expect(mockCreateRegistryRequest.mock.calls[0]?.[0]?.data?.sendFundingLovelace).toBeUndefined();
		expect(responseMock._getJSONData().data.RecipientWallet).toBeNull();
		expect(responseMock._getJSONData().data.sendFundingLovelace).toBeNull();
	});

	it('stores a managed recipient wallet override when provided', async () => {
		mockFindRecipientWallet.mockResolvedValue({
			id: 'recipient-wallet-id',
			walletVkey: 'recipient-wallet-vkey',
			walletAddress: 'addr_test1recipientwallet',
		});
		mockCreateRegistryRequest.mockResolvedValue(
			buildRegistryRequestResponse({
				walletVkey: 'recipient-wallet-vkey',
				walletAddress: 'addr_test1recipientwallet',
			}),
		);

		const { responseMock } = await testEndpoint({
			endpoint: registerAgentPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					network: Network.Preprod,
					sellingWalletVkey: 'selling-wallet-vkey',
					recipientWalletAddress: 'addr_test1recipientwallet',
					name: 'Test Agent',
					description: 'Agent description',
					apiBaseUrl: 'https://example.com/agent',
					Tags: ['demo'],
					Capability: {
						name: 'demo',
						version: '1.0.0',
					},
					AgentPricing: {
						pricingType: PricingType.Free,
					},
					Author: {
						name: 'Author',
					},
					ExampleOutputs: [],
				},
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockFindRecipientWallet).toHaveBeenCalledWith({
			where: {
				walletAddress: 'addr_test1recipientwallet',
				paymentSourceId: 'payment-source-1',
				deletedAt: null,
			},
			select: {
				id: true,
				walletVkey: true,
				walletAddress: true,
			},
		});
		expect(mockCreateRegistryRequest.mock.calls[0]?.[0]?.data?.RecipientWallet).toEqual({
			connect: {
				id: 'recipient-wallet-id',
			},
		});
		expect(responseMock._getJSONData().data.RecipientWallet).toEqual({
			walletVkey: 'recipient-wallet-vkey',
			walletAddress: 'addr_test1recipientwallet',
		});
	});

	it('stores a normalized send funding lovelace override when provided', async () => {
		mockCreateRegistryRequest.mockResolvedValue(buildRegistryRequestResponse(null, BigInt(5_000_000)));

		const { responseMock } = await testEndpoint({
			endpoint: registerAgentPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					network: Network.Preprod,
					sellingWalletVkey: 'selling-wallet-vkey',
					sendFundingLovelace: '2000000',
					name: 'Test Agent',
					description: 'Agent description',
					apiBaseUrl: 'https://example.com/agent',
					Tags: ['demo'],
					Capability: {
						name: 'demo',
						version: '1.0.0',
					},
					AgentPricing: {
						pricingType: PricingType.Free,
					},
					Author: {
						name: 'Author',
					},
					ExampleOutputs: [],
				},
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockCreateRegistryRequest.mock.calls[0]?.[0]?.data?.sendFundingLovelace).toBe(BigInt(5_000_000));
		expect(responseMock._getJSONData().data.sendFundingLovelace).toBe('5000000');
	});

	it('rejects recipient wallets outside the caller scope', async () => {
		mockFindApiKey.mockResolvedValue(asApiKey(['selling-wallet-id']));
		mockFindRecipientWallet.mockResolvedValue({
			id: 'recipient-wallet-id',
			walletVkey: 'recipient-wallet-vkey',
			walletAddress: 'addr_test1recipientwallet',
		});

		const { responseMock } = await testEndpoint({
			endpoint: registerAgentPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					network: Network.Preprod,
					sellingWalletVkey: 'selling-wallet-vkey',
					recipientWalletAddress: 'addr_test1recipientwallet',
					name: 'Test Agent',
					description: 'Agent description',
					apiBaseUrl: 'https://example.com/agent',
					Tags: ['demo'],
					Capability: {
						name: 'demo',
						version: '1.0.0',
					},
					AgentPricing: {
						pricingType: PricingType.Free,
					},
					Author: {
						name: 'Author',
					},
					ExampleOutputs: [],
				},
			},
		});

		expect(responseMock.statusCode).toBe(404);
		expect(mockCreateRegistryRequest).not.toHaveBeenCalled();
	});
});
