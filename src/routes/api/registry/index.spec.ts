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
const mockFindX402Networks = jest.fn() as AnyMock;
const mockValidateAssetsOnChain = jest.fn() as AnyMock;
const PREPROD_SCRIPT_ADDRESS = 'addr_test1wz7j4kmg2cs7yf92uat3ed4a3u97kr7axxr4avaz0lhwdsqukgwfm';

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
		x402Network: {
			findMany: mockFindX402Networks,
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
	validateAssetsOnChain: mockValidateAssetsOnChain,
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

beforeEach(() => {
	mockFindX402Networks.mockResolvedValue([{ caip2Id: 'eip155:8453' }, { caip2Id: 'eip155:84532' }]);
});

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
			smartContractAddress: PREPROD_SCRIPT_ADDRESS,
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
		Pricing: null,
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

function freeCardanoSource() {
	return {
		chain: 'Cardano' as const,
		network: Network.Preprod,
		paymentSourceType: PaymentSourceType.Web3CardanoV2,
		address: PREPROD_SCRIPT_ADDRESS,
		pricing: { pricingType: PricingType.Free },
	};
}

function materializePricing(create: any) {
	if (create == null) return null;
	return {
		pricingType: create.pricingType,
		FixedPricing: create.FixedPricing?.create
			? {
					Amounts: create.FixedPricing.create.Amounts.createMany.data,
				}
			: null,
	};
}

describe('registerAgentPost', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockFindApiKey.mockResolvedValue(asApiKey());
		mockFindSellingWallet.mockResolvedValue(buildSellingWallet());
		mockFindRecipientWallet.mockResolvedValue(null);
		mockCreateRegistryRequest.mockImplementation(async (args: any) => ({
			...buildRegistryRequestResponse(null),
			Pricing: materializePricing(args.data.Pricing?.create),
			SupportedPaymentSources:
				args.data.SupportedPaymentSources?.create?.map((source: any) => ({
					...source,
					Pricing: materializePricing(source.Pricing?.create),
				})) ?? [],
		}));
		mockFindRegistryRequests.mockResolvedValue([]);
		mockCountRegistryRequests.mockResolvedValue(0);
		mockValidateAssetsOnChain.mockResolvedValue({ valid: [], invalid: [] });
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
					supportedPaymentSources: [freeCardanoSource()],
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
		expect(mockCreateRegistryRequest.mock.calls[0]?.[0]?.data?.SupportedPaymentSources).toEqual({
			create: [
				expect.objectContaining({
					chain: 'Cardano',
					network: Network.Preprod,
					paymentSourceType: PaymentSourceType.Web3CardanoV2,
					address: PREPROD_SCRIPT_ADDRESS,
					Pricing: { create: { pricingType: PricingType.Free } },
				}),
			],
		});
		expect(mockCreateRegistryRequest.mock.calls[0]?.[0]?.data?.sendFundingLovelace).toBeUndefined();
		expect(responseMock._getJSONData().data.RecipientWallet).toBeNull();
		expect(responseMock._getJSONData().data.supportedPaymentSources).toEqual([
			{
				chain: 'Cardano',
				network: Network.Preprod,
				paymentSourceType: PaymentSourceType.Web3CardanoV2,
				address: PREPROD_SCRIPT_ADDRESS,
				pricing: { pricingType: PricingType.Free },
			},
		]);
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
					ExampleOutputs: [],
				},
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockCreateRegistryRequest.mock.calls[0]?.[0]?.data?.metadataVersion).toBe(1);
		expect(mockCreateRegistryRequest.mock.calls[0]?.[0]?.data?.SupportedPaymentSources).toBeUndefined();
	});

	it('preserves fixed AgentPricing for V1 registrations', async () => {
		mockFindSellingWallet.mockResolvedValue(buildV1SellingWallet());

		const { responseMock } = await testEndpoint({
			endpoint: registerAgentPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					network: Network.Preprod,
					sellingWalletVkey: 'b'.repeat(56),
					name: 'Paid V1 Agent',
					description: 'Agent description',
					apiBaseUrl: 'https://example.com/agent',
					Tags: ['demo'],
					Capability: {
						name: 'demo',
						version: '1.0.0',
					},
					AgentPricing: {
						pricingType: PricingType.Fixed,
						Pricing: [{ unit: 'lovelace', amount: '500000' }],
					},
					Author: {
						name: 'Author',
					},
					ExampleOutputs: [],
				},
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockCreateRegistryRequest.mock.calls[0]?.[0]?.data?.Pricing).toEqual({
			create: {
				pricingType: PricingType.Fixed,
				FixedPricing: {
					create: {
						Amounts: {
							createMany: {
								data: [{ unit: '', amount: BigInt(500000) }],
							},
						},
					},
				},
			},
		});
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
					supportedPaymentSources: [freeCardanoSource()],
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

	it('persists dynamic, fixed ERC-20, and free x402 pricing models', async () => {
		const dynamicPayTo = `0x${'1'.repeat(40)}`;
		const fixedPayTo = `0x${'2'.repeat(40)}`;
		const freePayTo = `0x${'3'.repeat(40)}`;
		const fixedAsset = '0x036CbD53842c5426634e7929541eC2318f3dCF7c';

		const { responseMock } = await testEndpoint({
			endpoint: registerAgentPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					network: Network.Preprod,
					sellingWalletVkey: 'b'.repeat(56),
					name: 'V2 x402 Agent',
					description: 'Agent description',
					apiBaseUrl: 'https://example.com/agent',
					Tags: ['demo'],
					Capability: {
						name: 'demo',
						version: '1.0.0',
					},
					Author: {
						name: 'Author',
					},
					supportedPaymentSources: [
						{
							chain: 'EVM',
							network: 'eip155:84532',
							scheme: 'Exact',
							payTo: dynamicPayTo,
							pricing: { pricingType: PricingType.Dynamic },
						},
						{
							chain: 'EVM',
							network: 'eip155:84532',
							scheme: 'Exact',
							payTo: fixedPayTo,
							pricing: {
								pricingType: PricingType.Fixed,
								fixed: [{ asset: fixedAsset, amount: '1000', decimals: 6 }],
							},
						},
						{
							chain: 'EVM',
							network: 'eip155:84532',
							scheme: 'Exact',
							payTo: freePayTo,
							pricing: { pricingType: PricingType.Free },
						},
					],
					ExampleOutputs: [],
				},
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockCreateRegistryRequest.mock.calls[0]?.[0]?.data?.Pricing).toBeUndefined();
		expect(mockCreateRegistryRequest.mock.calls[0]?.[0]?.data?.SupportedPaymentSources).toEqual({
			create: [
				expect.objectContaining({
					chain: 'EVM',
					network: 'eip155:84532',
					paymentSourceType: null,
					address: dynamicPayTo,
					scheme: 'Exact',
					payTo: dynamicPayTo,
					Pricing: { create: { pricingType: PricingType.Dynamic } },
				}),
				expect.objectContaining({
					chain: 'EVM',
					network: 'eip155:84532',
					paymentSourceType: null,
					address: fixedPayTo,
					scheme: 'Exact',
					fixedDecimals: 6,
					payTo: fixedPayTo,
					Pricing: {
						create: {
							pricingType: PricingType.Fixed,
							FixedPricing: {
								create: {
									Amounts: {
										createMany: {
											data: [{ unit: fixedAsset.toLowerCase(), amount: BigInt(1000) }],
										},
									},
								},
							},
						},
					},
				}),
				expect.objectContaining({
					chain: 'EVM',
					network: 'eip155:84532',
					paymentSourceType: null,
					address: freePayTo,
					scheme: 'Exact',
					payTo: freePayTo,
					Pricing: { create: { pricingType: PricingType.Free } },
				}),
			],
		});
		expect(responseMock._getJSONData().data.supportedPaymentSources).toHaveLength(3);
		expect(
			responseMock
				._getJSONData()
				.data.supportedPaymentSources.every((supportedSource: { chain: string }) => supportedSource.chain === 'EVM'),
		).toBe(true);
	});

	it('rejects legacy AgentPricing on V2 instead of silently discarding it', async () => {
		const { responseMock } = await testEndpoint({
			endpoint: registerAgentPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					network: Network.Preprod,
					sellingWalletVkey: 'b'.repeat(56),
					name: 'EVM-only Agent',
					description: 'Agent description',
					apiBaseUrl: 'https://example.com/agent',
					Tags: ['demo'],
					Capability: { name: 'demo', version: '1.0.0' },
					AgentPricing: { pricingType: PricingType.Dynamic },
					Author: { name: 'Author' },
					supportedPaymentSources: [
						{
							chain: 'EVM',
							network: 'eip155:84532',
							scheme: 'Exact',
							payTo: `0x${'1'.repeat(40)}`,
							pricing: { pricingType: PricingType.Dynamic },
						},
					],
					ExampleOutputs: [],
				},
			},
		});

		expect(responseMock.statusCode).toBe(400);
		expect(JSON.stringify(responseMock._getJSONData())).toContain(
			'V2 registrations must not set AgentPricing; put pricing inside each supportedPaymentSources[].pricing field',
		);
		expect(mockCreateRegistryRequest).not.toHaveBeenCalled();
	});

	it('rejects supportedPaymentSources on V1 instead of silently discarding them', async () => {
		mockFindSellingWallet.mockResolvedValue(buildV1SellingWallet());

		const { responseMock } = await testEndpoint({
			endpoint: registerAgentPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					network: Network.Preprod,
					sellingWalletVkey: 'b'.repeat(56),
					name: 'Invalid V1 Agent',
					description: 'Agent description',
					apiBaseUrl: 'https://example.com/agent',
					Tags: ['demo'],
					Capability: { name: 'demo', version: '1.0.0' },
					AgentPricing: { pricingType: PricingType.Free },
					Author: { name: 'Author' },
					supportedPaymentSources: [freeCardanoSource()],
					ExampleOutputs: [],
				},
			},
		});

		expect(responseMock.statusCode).toBe(400);
		expect(JSON.stringify(responseMock._getJSONData())).toContain(
			'V1 registrations must not set supportedPaymentSources; use the top-level AgentPricing field',
		);
		expect(mockCreateRegistryRequest).not.toHaveBeenCalled();
	});

	it('requires top-level AgentPricing on V1', async () => {
		mockFindSellingWallet.mockResolvedValue(buildV1SellingWallet());

		const { responseMock } = await testEndpoint({
			endpoint: registerAgentPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					network: Network.Preprod,
					sellingWalletVkey: 'b'.repeat(56),
					name: 'Incomplete V1 Agent',
					description: 'Agent description',
					apiBaseUrl: 'https://example.com/agent',
					Tags: ['demo'],
					Capability: { name: 'demo', version: '1.0.0' },
					Author: { name: 'Author' },
					ExampleOutputs: [],
				},
			},
		});

		expect(responseMock.statusCode).toBe(400);
		expect(JSON.stringify(responseMock._getJSONData())).toContain(
			'V1 registrations require the top-level AgentPricing field',
		);
		expect(mockCreateRegistryRequest).not.toHaveBeenCalled();
	});

	it('requires source-local pricing on V2', async () => {
		const { responseMock } = await testEndpoint({
			endpoint: registerAgentPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					network: Network.Preprod,
					sellingWalletVkey: 'b'.repeat(56),
					name: 'Incomplete V2 Agent',
					description: 'Agent description',
					apiBaseUrl: 'https://example.com/agent',
					Tags: ['demo'],
					Capability: { name: 'demo', version: '1.0.0' },
					Author: { name: 'Author' },
					ExampleOutputs: [],
				},
			},
		});

		expect(responseMock.statusCode).toBe(400);
		expect(JSON.stringify(responseMock._getJSONData())).toContain(
			'V2 registrations require supportedPaymentSources with source-local pricing',
		);
		expect(mockCreateRegistryRequest).not.toHaveBeenCalled();
	});

	it('rejects an x402 source whose address alias does not match payTo', async () => {
		const { responseMock } = await testEndpoint({
			endpoint: registerAgentPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					network: Network.Preprod,
					sellingWalletVkey: 'b'.repeat(56),
					name: 'Legacy alias Agent',
					description: 'Agent description',
					apiBaseUrl: 'https://example.com/agent',
					Tags: ['demo'],
					Capability: { name: 'demo', version: '1.0.0' },
					Author: { name: 'Author' },
					supportedPaymentSources: [
						{
							chain: 'EVM',
							network: 'eip155:84532',
							scheme: 'Exact',
							address: `0x${'4'.repeat(40)}`,
							payTo: `0x${'2'.repeat(40)}`,
							pricing: {
								pricingType: PricingType.Fixed,
								fixed: [
									{
										asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7c',
										amount: '1000',
										decimals: 6,
									},
								],
							},
						},
					],
					ExampleOutputs: [],
				},
			},
		});

		expect(responseMock.statusCode).toBe(400);
		expect(mockCreateRegistryRequest).not.toHaveBeenCalled();
	});

	it('rejects an x402 option whose network is not available for settlement', async () => {
		mockFindX402Networks.mockResolvedValueOnce([]);

		const { responseMock } = await testEndpoint({
			endpoint: registerAgentPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					network: Network.Preprod,
					sellingWalletVkey: 'b'.repeat(56),
					name: 'Unavailable x402 Agent',
					description: 'Agent description',
					apiBaseUrl: 'https://example.com/agent',
					Tags: ['demo'],
					Capability: { name: 'demo', version: '1.0.0' },
					Author: { name: 'Author' },
					supportedPaymentSources: [
						{
							chain: 'EVM',
							network: 'eip155:84532',
							scheme: 'Exact',
							payTo: `0x${'1'.repeat(40)}`,
							pricing: { pricingType: PricingType.Dynamic },
						},
					],
					ExampleOutputs: [],
				},
			},
		});

		expect(responseMock.statusCode).toBe(400);
		expect(JSON.stringify(responseMock._getJSONData())).toContain(
			'x402 network is not available for settlement: eip155:84532',
		);
		expect(mockCreateRegistryRequest).not.toHaveBeenCalled();
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
					supportedPaymentSources: [freeCardanoSource()],
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
					supportedPaymentSources: [freeCardanoSource()],
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
					supportedPaymentSources: [freeCardanoSource()],
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
