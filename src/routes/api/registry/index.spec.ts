import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { testEndpoint } from 'express-zod-api';
import { ApiKeyStatus, Network, PaymentSourceType, PricingType, RegistrationState } from '@/generated/prisma/enums';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindApiKey = jest.fn() as AnyMock;
const mockFindSellingWallet = jest.fn() as AnyMock;
const mockFindRecipientWallet = jest.fn() as AnyMock;
const mockCreateRegistryRequest = jest.fn() as AnyMock;
const mockFindRegistryRequests = jest.fn() as AnyMock;
const mockCountRegistryRequests = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		apiKey: {
			findUnique: mockFindApiKey,
		},
		hotWallet: {
			// Both lookups go through findFirst since walletVkey's uniqueness moved
			// to a partial index (no longer a Prisma unique key). Route on the
			// distinguishing predicate: the selling lookup keys on walletVkey, the
			// recipient lookup on walletAddress.
			findFirst: (args: { where?: { walletVkey?: string } }) =>
				args?.where?.walletVkey !== undefined ? mockFindSellingWallet(args) : mockFindRecipientWallet(args),
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

jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONFIG: {
		ENCRYPTION_KEY: '12345678901234567890',
	},
	DEFAULTS: {
		DEFAULT_METADATA_VERSION: 1,
		DEFAULT_REGISTRY_METADATA_VERSION: 2,
		DEFAULT_ADMIN_SIGNATURES_V2: 2,
		ADMIN_WALLET1_PREPROD:
			'addr_test1qq0e6dy7cehm9zfqurcf8mwwg9te9nszsx5gy5q4eclpd0czhmdlpagxe5n8ppnrf6424tt8gwweumrtg2q7234x2p2qzjenfx',
		ADMIN_WALLET2_PREPROD:
			'addr_test1qqk38pk6rruh67j76s5e3sjj3uce6kr8329kgpg9umhp8k50t3yt4hw3u4fg4f4xtfh630g5fvg6fkr4p2svzyug4nsq40tdna',
		ADMIN_WALLET3_PREPROD:
			'addr_test1qq0e6dy7cehm9zfqurcf8mwwg9te9nszsx5gy5q4eclpd0czhmdlpagxe5n8ppnrf6424tt8gwweumrtg2q7234x2p2qzjenfx',
		ADMIN_WALLET1_MAINNET: 'addr1w859pcn45l8mc85s65cjk6t56mk0evgp9wjlpyht3k42wwc3hq2df',
		ADMIN_WALLET2_MAINNET: 'addr1w859pcn45l8mc85s65cjk6t56mk0evgp9wjlpyht3k42wwc3hq2df',
		ADMIN_WALLET3_MAINNET: 'addr1w859pcn45l8mc85s65cjk6t56mk0evgp9wjlpyht3k42wwc3hq2df',
		COOLDOWN_TIME_PREPROD: 420000,
		COOLDOWN_TIME_MAINNET: 420000,
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

jest.unstable_mockModule('@masumi/payment-core/metrics', () => ({
	recordBusinessEndpointError: jest.fn(),
}));

jest.unstable_mockModule('@/utils/blockfrost', () => ({
	getBlockfrostInstance: jest.fn(),
	validateAssetsOnChain: jest.fn(),
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
		walletVkey: 'b'.repeat(56),
		walletAddress: 'addr_test1sellingwallet',
		PaymentSource: {
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
			smartContractAddress: 'addr_test1smartcontract',
			network: Network.Preprod,
			PaymentSourceConfig: {
				rpcProviderApiKey: 'provider-key',
			},
		},
	};
}

function buildV1SellingWallet() {
	return {
		...buildSellingWallet(),
		PaymentSource: {
			...buildSellingWallet().PaymentSource,
			paymentSourceType: PaymentSourceType.Web3CardanoV1,
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
			walletVkey: 'b'.repeat(56),
			walletAddress: 'addr_test1sellingwallet',
		},
		RecipientWallet: recipientWallet,
		SupportedPaymentSources: [],
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
					PaymentSource: {
						network: Network.Preprod,
						deletedAt: null,
						smartContractAddress: undefined,
						paymentSourceType: PaymentSourceType.Web3CardanoV1,
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
				}),
			}),
		);
	});

	it('matches supported payment source filters against implicit registered Cardano sources', async () => {
		const { responseMock } = await testEndpoint({
			endpoint: queryRegistryRequestGet,
			requestProps: {
				method: 'GET',
				headers: { token: 'valid' },
				query: {
					network: Network.Preprod,
					limit: '10',
					filterSupportedPaymentSourceAddress: 'addr_test1smartcontract',
				},
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockFindRegistryRequests).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					PaymentSource: {
						network: Network.Preprod,
						deletedAt: null,
						smartContractAddress: undefined,
						paymentSourceType: undefined,
					},
					AND: [
						{
							OR: [
								{
									SupportedPaymentSources: {
										some: {
											OR: [{ address: 'addr_test1smartcontract' }],
										},
									},
								},
								{
									PaymentSource: {
										network: Network.Preprod,
										deletedAt: null,
										smartContractAddress: 'addr_test1smartcontract',
									},
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
					paymentSourceType: PaymentSourceType.Web3CardanoV1,
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
					sellingWalletVkey: 'b'.repeat(56),
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
		expect(mockCreateRegistryRequest.mock.calls[0]?.[0]?.data?.SupportedPaymentSources).toBeUndefined();
		expect(mockCreateRegistryRequest.mock.calls[0]?.[0]?.data?.sendFundingLovelace).toBeUndefined();
		expect(responseMock._getJSONData().data.RecipientWallet).toBeNull();
		expect(responseMock._getJSONData().data.supportedPaymentSources).toBeNull();
		expect(responseMock._getJSONData().data.sendFundingLovelace).toBeNull();
	});

	it('keeps V1 registrations on metadata schema version 1 for old-schema compatibility', async () => {
		mockFindSellingWallet.mockResolvedValue(buildV1SellingWallet());

		const { responseMock } = await testEndpoint({
			endpoint: registerAgentPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					network: Network.Preprod,
					sellingWalletVkey: 'b'.repeat(56),
					name: 'Legacy Agent',
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
					supportedPaymentSources: [
						{
							chain: 'Cardano',
							network: Network.Preprod,
							paymentSourceType: PaymentSourceType.Web3CardanoV1,
							address: 'addr_test1smartcontract',
						},
					],
					ExampleOutputs: [],
				},
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockCreateRegistryRequest.mock.calls[0]?.[0]?.data?.metadataVersion).toBe(1);
		expect(mockCreateRegistryRequest.mock.calls[0]?.[0]?.data?.SupportedPaymentSources).toBeUndefined();
	});

	it('keeps V2 registrations on registry metadata schema version 2', async () => {
		const { responseMock } = await testEndpoint({
			endpoint: registerAgentPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					network: Network.Preprod,
					sellingWalletVkey: 'b'.repeat(56),
					name: 'V2 Agent',
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
		expect(mockCreateRegistryRequest.mock.calls[0]?.[0]?.data?.metadataVersion).toBe(2);
	});

	it('stores a managed recipient wallet override when provided', async () => {
		mockFindRecipientWallet.mockResolvedValue({
			id: 'recipient-wallet-id',
			walletVkey: 'recipient-wallet-vkey',
			walletAddress: 'addr_test1qrecipientwallet000000000000000000000000000000000',
		});
		mockCreateRegistryRequest.mockResolvedValue(
			buildRegistryRequestResponse({
				walletVkey: 'recipient-wallet-vkey',
				walletAddress: 'addr_test1qrecipientwallet000000000000000000000000000000000',
			}),
		);

		const { responseMock } = await testEndpoint({
			endpoint: registerAgentPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					network: Network.Preprod,
					sellingWalletVkey: 'b'.repeat(56),
					recipientWalletAddress: 'addr_test1qrecipientwallet000000000000000000000000000000000',
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
				walletAddress: 'addr_test1qrecipientwallet000000000000000000000000000000000',
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
			walletAddress: 'addr_test1qrecipientwallet000000000000000000000000000000000',
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
					sellingWalletVkey: 'b'.repeat(56),
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
			walletAddress: 'addr_test1qrecipientwallet000000000000000000000000000000000',
		});

		const { responseMock } = await testEndpoint({
			endpoint: registerAgentPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					network: Network.Preprod,
					sellingWalletVkey: 'b'.repeat(56),
					recipientWalletAddress: 'addr_test1qrecipientwallet000000000000000000000000000000000',
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
