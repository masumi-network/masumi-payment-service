import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockSupportedPaymentSourceFindUnique = jest.fn() as jest.Mock<any>;
const mockX402NetworkFindUnique = jest.fn() as jest.Mock<any>;
const mockTxX402NetworkFindUnique = jest.fn() as jest.Mock<any>;
const mockX402NetworkUpsert = jest.fn() as jest.Mock<any>;
const mockX402SettlementFindUnique = jest.fn() as jest.Mock<any>;
const mockX402SettlementCreate = jest.fn() as jest.Mock<any>;
const mockX402PaymentAttemptCreate = jest.fn() as jest.Mock<any>;
const mockX402PaymentAttemptUpdate = jest.fn() as jest.Mock<any>;
const mockX402PaymentAttemptUpdateMany = jest.fn() as jest.Mock<any>;
const mockX402PaymentAttemptFindFirst = jest.fn() as jest.Mock<any>;
const mockX402PaymentAttemptFindUnique = jest.fn() as jest.Mock<any>;
const mockTxX402PaymentAttemptFindUnique = jest.fn() as jest.Mock<any>;
const mockX402EvmWalletFindUnique = jest.fn() as jest.Mock<any>;
const mockX402EvmWalletFindFirst = jest.fn() as jest.Mock<any>;
const mockX402EvmWalletUpdateMany = jest.fn() as jest.Mock<any>;
const mockApiKeyFindUnique = jest.fn() as jest.Mock<any>;
const mockX402EvmWalletCreate = jest.fn() as jest.Mock<any>;
const mockX402WalletSecretFindUniqueOrThrow = jest.fn() as jest.Mock<any>;
const mockCounterpartyUpsert = jest.fn() as jest.Mock<any>;
const mockCounterpartyFindUniqueOrThrow = jest.fn() as jest.Mock<any>;
const mockExecuteRaw = jest.fn() as jest.Mock<any>;
const mockQueryRaw = jest.fn() as jest.Mock<any>;
const mockBudgetFindFirst = jest.fn() as jest.Mock<any>;
// On-chain reads for the buy-side balance pre-check (readContract = ERC-20 balanceOf).
const mockReadContract = jest.fn() as jest.Mock<any>;
const mockGetBalance = jest.fn() as jest.Mock<any>;

// Minimal stand-in for Prisma's known-request error so the service's
// `instanceof Prisma.PrismaClientKnownRequestError` checks behave under the db mock.
class MockPrismaClientKnownRequestError extends Error {
	code: string;
	constructor(message: string, code: string) {
		super(message);
		this.code = code;
	}
}
const mockBudgetUpdateMany = jest.fn() as jest.Mock<any>;
const mockBudgetRefundUpdateMany = jest.fn() as jest.Mock<any>;
const mockBudgetUpdate = jest.fn() as jest.Mock<any>;
const mockBudgetUpsert = jest.fn() as jest.Mock<any>;
const mockTxPaymentAttemptCreate = jest.fn() as jest.Mock<any>;
const mockPrismaTransaction = jest.fn() as jest.Mock<any>;
const mockFacilitatorVerify = jest.fn() as jest.Mock<any>;
const mockFacilitatorSettle = jest.fn() as jest.Mock<any>;
const mockExtractAndValidatePaymentIdentifier = jest.fn() as jest.Mock<any>;
const mockEncodePaymentSignatureHeader = jest.fn() as jest.Mock<any>;
const mockCreatePaymentPayload = jest.fn() as jest.Mock<any>;

type MockX402Client = {
	policies: Array<(version: number, requirements: any[]) => any[]>;
	extensions: any[];
	registerPolicy: (policy: (version: number, requirements: any[]) => any[]) => MockX402Client;
	registerExtension: (extension: any) => MockX402Client;
	createPaymentPayload: (paymentRequired: any) => Promise<any>;
};

let latestClient: MockX402Client | null = null;

class X402ClientMock implements MockX402Client {
	policies: Array<(version: number, requirements: any[]) => any[]> = [];
	extensions: any[] = [];

	constructor() {
		latestClient = this;
	}

	registerPolicy(policy: (version: number, requirements: any[]) => any[]) {
		this.policies.push(policy);
		return this;
	}

	registerExtension(extension: any) {
		this.extensions.push(extension);
		return this;
	}

	async createPaymentPayload(paymentRequired: any) {
		return mockCreatePaymentPayload(paymentRequired);
	}
}

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	Prisma: {
		PrismaClientKnownRequestError: MockPrismaClientKnownRequestError,
		TransactionIsolationLevel: { Serializable: 'Serializable' },
	},
	X402EvmWalletType: {
		Purchasing: 'Purchasing',
		Selling: 'Selling',
	},
	X402CounterpartyRole: {
		Payee: 'Payee',
		Payer: 'Payer',
	},
	X402FacilitatorMode: {
		SelfHosted: 'SelfHosted',
		Remote: 'Remote',
	},
	X402PaymentDirection: {
		InboundVerify: 'InboundVerify',
		InboundSettle: 'InboundSettle',
		OutboundPayment: 'OutboundPayment',
	},
	X402PaymentScheme: {
		Exact: 'Exact',
	},
	PricingType: {
		Fixed: 'Fixed',
		Dynamic: 'Dynamic',
		Free: 'Free',
	},
	X402PaymentStatus: {
		PaymentRequired: 'PaymentRequired',
		Verified: 'Verified',
		Settled: 'Settled',
		Failed: 'Failed',
		Replayed: 'Replayed',
	},
	prisma: {
		supportedPaymentSource: {
			findUnique: mockSupportedPaymentSourceFindUnique,
		},
		x402Network: {
			findUnique: mockX402NetworkFindUnique,
			upsert: mockX402NetworkUpsert,
		},
		apiKey: {
			findUnique: mockApiKeyFindUnique,
		},
		x402Settlement: {
			findUnique: mockX402SettlementFindUnique,
			create: mockX402SettlementCreate,
		},
		x402PaymentAttempt: {
			create: mockX402PaymentAttemptCreate,
			update: mockX402PaymentAttemptUpdate,
			updateMany: mockX402PaymentAttemptUpdateMany,
			findFirst: mockX402PaymentAttemptFindFirst,
			findUnique: mockX402PaymentAttemptFindUnique,
		},
		x402EvmWallet: {
			findUnique: mockX402EvmWalletFindUnique,
			findFirst: mockX402EvmWalletFindFirst,
			create: mockX402EvmWalletCreate,
			updateMany: mockX402EvmWalletUpdateMany,
			findMany: jest.fn(),
		},
		x402WalletSecret: {
			findUniqueOrThrow: mockX402WalletSecretFindUniqueOrThrow,
		},
		x402CounterpartyWallet: {
			upsert: mockCounterpartyUpsert,
			findUniqueOrThrow: mockCounterpartyFindUniqueOrThrow,
		},
		$executeRaw: mockExecuteRaw,
		$queryRaw: mockQueryRaw,
		x402WalletBudget: {
			findFirst: mockBudgetFindFirst,
			update: mockBudgetUpdate,
			updateMany: mockBudgetRefundUpdateMany,
			upsert: mockBudgetUpsert,
			findMany: jest.fn(),
		},
		$transaction: mockPrismaTransaction,
	},
}));

jest.unstable_mockModule('@masumi/payment-core/encryption', () => ({
	decrypt: jest.fn(() => '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
	encrypt: jest.fn((value: string) => `encrypted:${value}`),
}));

jest.unstable_mockModule('@x402/core/client', () => ({
	x402Client: X402ClientMock,
}));

jest.unstable_mockModule('@x402/core/facilitator', () => ({
	x402Facilitator: jest.fn(() => ({
		verify: mockFacilitatorVerify,
		settle: mockFacilitatorSettle,
	})),
}));

class HTTPFacilitatorClientMock {
	config: unknown;
	constructor(config: unknown) {
		this.config = config;
	}
	verify(...args: unknown[]) {
		return mockFacilitatorVerify(...args);
	}
	settle(...args: unknown[]) {
		return mockFacilitatorSettle(...args);
	}
}

jest.unstable_mockModule('@x402/core/http', () => ({
	encodePaymentSignatureHeader: mockEncodePaymentSignatureHeader,
	HTTPFacilitatorClient: HTTPFacilitatorClientMock,
}));

jest.unstable_mockModule('./remote-facilitator', () => ({
	RemoteHTTPFacilitatorClient: jest.fn(() => ({
		verify: mockFacilitatorVerify,
		settle: mockFacilitatorSettle,
	})),
}));

jest.unstable_mockModule('@x402/evm', () => ({
	toClientEvmSigner: jest.fn(() => ({ signer: 'client-signer' })),
	toFacilitatorEvmSigner: jest.fn(() => ({ signer: 'facilitator-signer' })),
}));

jest.unstable_mockModule('@x402/evm/exact/client', () => ({
	registerExactEvmScheme: jest.fn(),
}));

jest.unstable_mockModule('@x402/evm/exact/facilitator', () => ({
	registerExactEvmScheme: jest.fn(),
}));

jest.unstable_mockModule('@x402/extensions/payment-identifier', () => ({
	PAYMENT_IDENTIFIER: 'payment-identifier',
	appendPaymentIdentifierToExtensions: jest.fn((extensions: Record<string, unknown>, id: string) => ({
		...extensions,
		'payment-identifier': id,
	})),
	extractAndValidatePaymentIdentifier: mockExtractAndValidatePaymentIdentifier,
}));

jest.unstable_mockModule('viem', () => ({
	// getChainId echoes the chain id the client was built with (defineChain passes the
	// chain through), so assertRpcServesDeclaredChain sees a matching live chain id.
	createPublicClient: jest.fn((opts: { chain?: { id?: number } }) => ({
		publicClient: true,
		getChainId: jest.fn(async () => opts?.chain?.id),
		getBalance: mockGetBalance,
		readContract: mockReadContract,
	})),
	createWalletClient: jest.fn((opts: { chain?: { id?: number } }) => ({
		extend: jest.fn(() => ({ walletClient: true, getChainId: jest.fn(async () => opts?.chain?.id) })),
	})),
	defineChain: jest.fn((chain: unknown) => chain),
	http: jest.fn((rpcUrl: string) => ({ rpcUrl })),
	publicActions: {},
}));

jest.unstable_mockModule('viem/accounts', () => ({
	generatePrivateKey: jest.fn(() => '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
	privateKeyToAccount: jest.fn(() => ({
		address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
	})),
}));

const service = await import('./service');
const requirementsService = await import('./requirements');
const internalService = await import('./internal');

const source = {
	id: 'source-1',
	registryRequestId: 'registry-1',
	chain: 'EVM',
	network: 'eip155:84532',
	scheme: 'Exact',
	pricingType: 'Fixed',
	asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
	amount: 10_000n,
	decimals: 6,
	payTo: '0x1111111111111111111111111111111111111111',
	resource: 'https://agent.example/run',
	extra: null,
	RegistryRequest: {
		id: 'registry-1',
		apiBaseUrl: 'https://agent.example',
		agentIdentifier: 'agent-1',
		requestedById: 'api-key-1',
	},
};

const networkUpdatedAt = new Date('2026-01-01T00:00:00.000Z');
const databaseClockNow = new Date('2026-07-16T12:00:00.000Z');

const requirements = {
	scheme: 'exact',
	network: source.network,
	asset: source.asset,
	amount: source.amount.toString(),
	payTo: source.payTo,
	maxTimeoutSeconds: 300,
	extra: {
		assetTransferMethod: 'permit2',
		decimals: source.decimals,
	},
};

const paymentPayload = {
	x402Version: 2,
	resource: { url: 'https://agent.example/run' },
	accepted: requirements,
	payload: {
		signature: '0xabc',
		authorization: { nonce: '0x01', value: requirements.amount },
	},
};
const typedPaymentPayload = paymentPayload as Parameters<typeof service.settleX402Payment>[0]['paymentPayload'];

// A raw 402 the buyer forwards to the service (buy side).
const paymentRequired = {
	x402Version: 2,
	resource: { url: 'https://agent.example/run' },
	accepts: [requirements],
} as Parameters<typeof service.createX402Payment>[0]['paymentRequired'];

describe('x402 service helpers', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockQueryRaw.mockImplementation(async (queryParts: readonly string[]) => {
			const sql = queryParts.join('');
			if (sql.includes('UPDATE "X402EvmWallet"')) return [{ lockedAt: databaseClockNow }];
			if (sql.includes('SELECT clock_timestamp()')) return [{ now: databaseClockNow }];
			return [];
		});
		latestClient = null;
		mockSupportedPaymentSourceFindUnique.mockResolvedValue(source);
		mockX402NetworkFindUnique.mockResolvedValue({
			id: 'network-1',
			caip2Id: source.network,
			displayName: 'Base Sepolia',
			rpcUrl: 'https://sepolia.base.org',
			isEnabled: true,
			updatedAt: networkUpdatedAt,
			facilitatorWalletId: 'wallet-facilitator',
			facilitatorUrl: null,
			facilitatorAuthEnc: null,
			FacilitatorWallet: {
				id: 'wallet-facilitator',
				type: 'Selling',
				deletedAt: null,
				Secret: { encryptedPrivateKey: 'encrypted-private-key' },
			},
		});
		mockX402EvmWalletFindUnique.mockResolvedValue({
			id: 'wallet-1',
			networkId: 'network-1',
			secretId: 'secret-1',
			address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			type: 'Purchasing',
			deletedAt: null,
			Secret: { encryptedPrivateKey: 'encrypted-private-key' },
			Network: {
				id: 'network-1',
				caip2Id: source.network,
				rpcUrl: 'https://sepolia.base.org',
				displayName: 'Base Sepolia',
			},
		});
		mockX402EvmWalletFindFirst.mockResolvedValue(null);
		mockX402WalletSecretFindUniqueOrThrow.mockResolvedValue({ id: 'secret-1' });
		// Lease acquire/renew use atomic raw UPDATEs; compare-and-release remains updateMany.
		mockX402EvmWalletUpdateMany.mockResolvedValue({ count: 1 });
		mockCounterpartyUpsert.mockResolvedValue({ id: 'counterparty-1' });
		// Counterparty resolution is now a native ON CONFLICT insert ($executeRaw) + id read-back.
		mockExecuteRaw.mockResolvedValue(1);
		mockCounterpartyFindUniqueOrThrow.mockResolvedValue({ id: 'counterparty-1' });
		mockApiKeyFindUnique.mockResolvedValue({ id: 'api-key-1' });
		mockX402EvmWalletCreate.mockResolvedValue({
			id: 'wallet-new',
			networkId: 'network-1',
			address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
			type: 'Purchasing',
			note: null,
			createdAt: new Date('2026-01-01T00:00:00.000Z'),
			updatedAt: new Date('2026-01-01T00:00:00.000Z'),
			createdById: 'api-key-1',
			Network: { caip2Id: source.network },
		});
		mockX402SettlementFindUnique.mockResolvedValue(null);
		mockX402SettlementCreate.mockImplementation(async (args: any) => ({ id: 'settlement-1', ...args.data }));
		mockX402PaymentAttemptCreate.mockResolvedValue({ id: 'attempt-1' });
		mockX402PaymentAttemptUpdate.mockResolvedValue({ id: 'attempt-1' });
		mockX402PaymentAttemptUpdateMany.mockResolvedValue({ count: 1 });
		// The upsert echoes a NETWORK_SELECT-shaped row so flattenNetwork can project it; the
		// facilitator-config tests assert on the `update` argument, not this return value.
		mockX402NetworkUpsert.mockResolvedValue({
			id: 'network-1',
			caip2Id: source.network,
			displayName: 'Base Sepolia',
			rpcUrl: 'https://sepolia.base.org',
			isTestnet: true,
			isEnabled: true,
			defaultAsset: null,
			defaultAssetDecimals: null,
			facilitatorWalletId: null,
			facilitatorUrl: null,
			FacilitatorWallet: null,
			createdById: null,
			createdAt: new Date('2026-01-01T00:00:00.000Z'),
			updatedAt: new Date('2026-01-01T00:00:00.000Z'),
		});
		mockFacilitatorVerify.mockResolvedValue({
			isValid: true,
			payer: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		});
		mockFacilitatorSettle.mockResolvedValue({
			success: true,
			transaction: '0xsettlement',
			network: source.network,
			amount: requirements.amount,
			payer: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		});
		mockExtractAndValidatePaymentIdentifier.mockReturnValue({
			id: null,
			validation: { valid: true },
		});
		mockEncodePaymentSignatureHeader.mockReturnValue('x-payment-header-base64');
		mockCreatePaymentPayload.mockResolvedValue(paymentPayload);
		mockBudgetFindFirst.mockResolvedValue({ id: 'budget-1', remainingAmount: 1_000_000n, generation: 0 });
		// Default the on-chain balance well above any test amount so the pre-check passes; the
		// insufficient-balance case overrides mockReadContract per test.
		mockReadContract.mockResolvedValue(1_000_000_000n);
		mockGetBalance.mockResolvedValue(1_000_000_000n);
		mockBudgetUpdateMany.mockResolvedValue({ count: 1 });
		mockBudgetRefundUpdateMany.mockResolvedValue({ count: 1 });
		mockX402PaymentAttemptFindFirst.mockResolvedValue(null);
		mockBudgetUpdate.mockResolvedValue({ id: 'budget-1' });
		mockBudgetUpsert.mockResolvedValue({
			id: 'budget-1',
			apiKeyId: 'api-key-1',
			evmWalletId: 'wallet-1',
			asset: source.asset.toLowerCase(),
			remainingAmount: 100n,
			spentAmount: 0n,
			createdById: null,
			createdAt: new Date('2026-01-01T00:00:00.000Z'),
			updatedAt: new Date('2026-01-01T00:00:00.000Z'),
			EvmWallet: { address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', Network: { caip2Id: source.network } },
		});
		mockTxX402NetworkFindUnique.mockResolvedValue({
			isEnabled: true,
			updatedAt: networkUpdatedAt,
			rpcUrl: 'https://sepolia.base.org',
			facilitatorWalletId: 'wallet-facilitator',
			facilitatorUrl: null,
			facilitatorAuthEnc: null,
		});
		mockTxPaymentAttemptCreate.mockResolvedValue({ id: 'attempt-outbound-1' });
		mockPrismaTransaction.mockImplementation(async (arg: unknown) => {
			// Prisma.$transaction supports both the array form (wallet delete) and the callback form
			// (reserveBudgetForAttempt, reconcile); the mock handles both.
			if (Array.isArray(arg)) return Promise.all(arg);
			const callback = arg as (tx: unknown) => Promise<unknown>;
			return callback({
				x402Network: {
					// upsertX402Network resolves default-asset state inside the transaction
					// (selecting defaultAsset/defaultAssetDecimals); route that lookup to the
					// top-level network mock the upsert tests queue, and every other
					// in-transaction network read to the dedicated tx mock.
					findUnique: (args: { select?: { defaultAsset?: boolean } }) =>
						args?.select?.defaultAsset ? mockX402NetworkFindUnique(args) : mockTxX402NetworkFindUnique(args),
					upsert: mockX402NetworkUpsert,
				},
				x402WalletBudget: {
					findFirst: mockBudgetFindFirst,
					updateMany: mockBudgetUpdateMany,
				},
				x402PaymentAttempt: {
					create: async (args: any) =>
						args.data?.direction === 'InboundSettle'
							? mockX402PaymentAttemptCreate(args)
							: mockTxPaymentAttemptCreate(args),
					findFirst: mockX402PaymentAttemptFindFirst,
					findUnique: mockTxX402PaymentAttemptFindUnique,
					update: mockX402PaymentAttemptUpdate,
					updateMany: mockX402PaymentAttemptUpdateMany,
				},
				x402Settlement: {
					create: mockX402SettlementCreate,
				},
				x402CounterpartyWallet: {
					upsert: mockCounterpartyUpsert,
					findUniqueOrThrow: mockCounterpartyFindUniqueOrThrow,
				},
				$executeRaw: mockExecuteRaw,
				$queryRaw: mockQueryRaw,
			});
		});
	});

	it('hashes canonical payment payload JSON independent of object key order', () => {
		const first = {
			x402Version: 2,
			accepted: requirements,
			payload: paymentPayload.payload,
		};
		const second = {
			payload: {
				authorization: { value: requirements.amount, nonce: '0x01' },
				signature: '0xabc',
			},
			accepted: {
				payTo: source.payTo,
				amount: requirements.amount,
				asset: source.asset,
				network: source.network,
				scheme: 'exact',
				maxTimeoutSeconds: 300,
				extra: {
					decimals: source.decimals,
					assetTransferMethod: 'permit2',
				},
			},
			x402Version: 2,
		};

		expect(service.hashX402PaymentPayload(first)).toBe(service.hashX402PaymentPayload(second));
	});

	it('labels native currencies from their selected chain without assuming ETH', () => {
		expect(internalService.nativeCurrencyForCaip2('eip155:137').symbol).toBe('POL');
		expect(internalService.nativeCurrencyForCaip2('eip155:56').symbol).toBe('BNB');
		expect(internalService.nativeCurrencyForCaip2('eip155:43114').symbol).toBe('AVAX');
		expect(internalService.nativeCurrencyForCaip2('eip155:999999').symbol).toBe('Native');
	});

	it('uses the runtime exact amount and asset for asset-agnostic dynamic pricing', () => {
		const dynamicRequirements = requirementsService.sourceToRequirements(
			{
				...source,
				pricingType: 'Dynamic',
				asset: null,
				amount: null,
				decimals: null,
			} as never,
			{
				...requirements,
				amount: '25000',
			} as never,
		);

		expect(dynamicRequirements).toMatchObject({
			asset: source.asset,
			amount: '25000',
			extra: {
				assetTransferMethod: 'permit2',
				decimals: source.decimals,
			},
		});
	});

	it('rejects native-currency exact settlement until a compatible scheme exists', () => {
		expect(() =>
			requirementsService.sourceToRequirements(
				{
					...source,
					pricingType: 'Dynamic',
					asset: null,
					amount: null,
					decimals: null,
				} as never,
				{
					...requirements,
					asset: 'native',
					amount: '1000000000000000',
					extra: { assetTransferMethod: 'native', decimals: 18 },
				} as never,
			),
		).toThrow('x402 asset must be an EVM token contract');
	});

	it('rejects dynamic amounts outside the persistence range and payment calls for free sources', () => {
		expect(() =>
			requirementsService.sourceToRequirements(
				{
					...source,
					pricingType: 'Dynamic',
					asset: null,
					amount: null,
					decimals: null,
				} as never,
				{ ...requirements, amount: '0' } as never,
			),
		).toThrow('x402 payment amount must be between 1 and 9223372036854775807 atomic units');

		expect(() =>
			requirementsService.sourceToRequirements(
				{
					...source,
					pricingType: 'Dynamic',
					asset: null,
					amount: null,
					decimals: null,
				} as never,
				{ ...requirements, amount: '9223372036854775808' } as never,
			),
		).toThrow('x402 payment amount must be between 1 and 9223372036854775807 atomic units');

		expect(() =>
			requirementsService.sourceToRequirements({
				...source,
				pricingType: 'Free',
				asset: null,
				amount: null,
				decimals: null,
			} as never),
		).toThrow('Free x402 sources do not require payment verification or settlement');
	});

	it('rejects settle when the API key is not allowed on the registered chain', async () => {
		await expect(
			service.settleX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: ['eip155:1'],
				supportedPaymentSourceId: source.id,
				paymentPayload: typedPaymentPayload,
			}),
		).rejects.toMatchObject({ status: 401 });

		expect(mockFacilitatorSettle).not.toHaveBeenCalled();
	});

	it('rejects dynamic verification without owner-issued runtime requirements', async () => {
		mockSupportedPaymentSourceFindUnique.mockResolvedValueOnce({
			...source,
			pricingType: 'Dynamic',
			asset: null,
			amount: null,
			decimals: null,
		});

		await expect(
			service.verifyX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: [source.network],
				supportedPaymentSourceId: source.id,
				paymentPayload: typedPaymentPayload,
			}),
		).rejects.toMatchObject({
			status: 400,
			message: 'Dynamic x402 sources require trusted runtime payment requirements',
		});

		expect(mockFacilitatorVerify).not.toHaveBeenCalled();
	});

	it('does not derive a dynamic amount from the buyer-controlled accepted payload', async () => {
		mockSupportedPaymentSourceFindUnique.mockResolvedValueOnce({
			...source,
			pricingType: 'Dynamic',
			asset: null,
			amount: null,
			decimals: null,
		});
		const trustedRuntimeRequirements = {
			...requirements,
			amount: '25000',
		};
		const forgedPayload = {
			...paymentPayload,
			accepted: {
				...requirements,
				amount: '1',
			},
		} as Parameters<typeof service.verifyX402Payment>[0]['paymentPayload'];

		await expect(
			service.verifyX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: [source.network],
				supportedPaymentSourceId: source.id,
				paymentPayload: forgedPayload,
				paymentRequirements: trustedRuntimeRequirements as never,
			}),
		).rejects.toMatchObject({
			status: 400,
			message: 'x402 payment requirements do not match the registered resource',
		});

		expect(mockFacilitatorVerify).not.toHaveBeenCalled();
	});

	it('only trusts dynamic requirements from the registry owner or an admin', async () => {
		mockSupportedPaymentSourceFindUnique.mockResolvedValueOnce({
			...source,
			pricingType: 'Dynamic',
			asset: null,
			amount: null,
			decimals: null,
		});
		await expect(
			service.verifyX402Payment({
				apiKeyId: 'different-api-key',
				caip2NetworkLimit: [source.network],
				supportedPaymentSourceId: source.id,
				paymentPayload: typedPaymentPayload,
			}),
		).rejects.toMatchObject({
			status: 403,
			message: 'x402 supported payment source belongs to another API key',
		});

		expect(mockFacilitatorVerify).not.toHaveBeenCalled();
	});

	it('keeps registered fixed pricing usable by another pay-scoped runtime key', async () => {
		mockX402PaymentAttemptCreate.mockResolvedValueOnce({ id: 'attempt-fixed-runtime' });

		await expect(
			service.verifyX402Payment({
				apiKeyId: 'different-api-key',
				caip2NetworkLimit: [source.network],
				supportedPaymentSourceId: source.id,
				paymentPayload: typedPaymentPayload,
			}),
		).resolves.toMatchObject({ attemptId: 'attempt-fixed-runtime' });

		expect(mockFacilitatorVerify).toHaveBeenCalledTimes(1);
	});

	it('deduplicates settle replays by canonical payment payload hash bound to the same source', async () => {
		const paymentPayloadHash = service.hashX402PaymentPayload(paymentPayload);
		mockX402SettlementFindUnique.mockResolvedValue({
			id: 'settlement-1',
			paymentPayloadHash,
			txHash: '0xsettled',
			amount: source.amount,
			PaymentAttempt: {
				id: 'attempt-original',
				supportedPaymentSourceId: source.id,
				networkId: 'network-1',
				counterpartyWalletId: 'counterparty-original',
				Network: { caip2Id: source.network },
				CounterpartyWallet: { address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
			},
		});
		mockX402PaymentAttemptCreate.mockResolvedValue({ id: 'attempt-replay' });

		const result = await service.settleX402Payment({
			apiKeyId: 'api-key-1',
			caip2NetworkLimit: [source.network],
			supportedPaymentSourceId: source.id,
			paymentPayload: typedPaymentPayload,
		});

		expect(result).toMatchObject({
			attemptId: 'attempt-replay',
			paymentPayloadHash,
			replay: true,
			settleResponse: {
				success: true,
				transaction: '0xsettled',
				network: source.network,
				amount: source.amount.toString(),
				payer: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			},
		});
		expect(mockFacilitatorSettle).not.toHaveBeenCalled();
		expect(mockX402PaymentAttemptCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: 'Replayed',
					paymentPayloadHash,
					payTo: source.payTo.toLowerCase(),
					// The original attempt's counterparty is reused directly — no upsert round-trip.
					counterpartyWalletId: 'counterparty-original',
				}),
			}),
		);
		expect(mockExecuteRaw).not.toHaveBeenCalled();
	});

	it('rejects a settle replay whose prior settlement belongs to a different source', async () => {
		const paymentPayloadHash = service.hashX402PaymentPayload(paymentPayload);
		mockX402SettlementFindUnique.mockResolvedValue({
			id: 'settlement-1',
			paymentPayloadHash,
			txHash: '0xsettled',
			amount: source.amount,
			PaymentAttempt: {
				id: 'attempt-original',
				supportedPaymentSourceId: 'a-different-source',
				networkId: 'network-1',
				counterpartyWalletId: 'counterparty-original',
				Network: { caip2Id: source.network },
				CounterpartyWallet: { address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
			},
		});

		await expect(
			service.settleX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: [source.network],
				supportedPaymentSourceId: source.id,
				paymentPayload: typedPaymentPayload,
			}),
		).rejects.toMatchObject({ status: 409 });

		expect(mockFacilitatorSettle).not.toHaveBeenCalled();
		expect(mockX402PaymentAttemptCreate).not.toHaveBeenCalled();
	});

	it('rejects invalid payment-identifier payloads before verification', async () => {
		mockExtractAndValidatePaymentIdentifier.mockReturnValue({
			id: 'bad-identifier',
			validation: {
				valid: false,
				errors: ['payment-identifier expired'],
			},
		});

		await expect(
			service.verifyX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: [source.network],
				supportedPaymentSourceId: source.id,
				paymentPayload: typedPaymentPayload,
			}),
		).rejects.toMatchObject({ status: 400, message: 'payment-identifier expired' });

		expect(mockFacilitatorVerify).not.toHaveBeenCalled();
	});

	it.each([
		['network', { network: 'eip155:8453' }],
		['token', { asset: '0x2222222222222222222222222222222222222222' }],
		['amount', { amount: '999' }],
		['payTo', { payTo: '0x3333333333333333333333333333333333333333' }],
	])('rejects verify payloads with the wrong registered %s', async (_field, acceptedPatch) => {
		await expect(
			service.verifyX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: [source.network],
				supportedPaymentSourceId: source.id,
				paymentPayload: {
					...paymentPayload,
					accepted: {
						...requirements,
						...acceptedPatch,
					},
				} as Parameters<typeof service.verifyX402Payment>[0]['paymentPayload'],
			}),
		).rejects.toMatchObject({
			status: 400,
			message: 'x402 payment requirements do not match the registered resource',
		});

		expect(mockFacilitatorVerify).not.toHaveBeenCalled();
	});

	it('rejects settle payload requirement mismatches before replay lookup', async () => {
		await expect(
			service.settleX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: [source.network],
				supportedPaymentSourceId: source.id,
				paymentPayload: {
					...paymentPayload,
					accepted: {
						...requirements,
						amount: '999',
					},
				} as Parameters<typeof service.settleX402Payment>[0]['paymentPayload'],
			}),
		).rejects.toMatchObject({
			status: 400,
			message: 'x402 payment requirements do not match the registered resource',
		});

		expect(mockX402SettlementFindUnique).not.toHaveBeenCalled();
		expect(mockFacilitatorSettle).not.toHaveBeenCalled();
	});

	it('rejects payment payloads for a different registered resource', async () => {
		await expect(
			service.verifyX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: [source.network],
				supportedPaymentSourceId: source.id,
				paymentPayload: {
					...paymentPayload,
					resource: { url: 'https://agent.example/other' },
				} as Parameters<typeof service.verifyX402Payment>[0]['paymentPayload'],
			}),
		).rejects.toMatchObject({ status: 400 });

		expect(mockFacilitatorVerify).not.toHaveBeenCalled();
	});

	it('normalizes x402 budget assets to lowercase when upserting', async () => {
		const result = await service.setX402WalletBudget({
			apiKeyId: 'api-key-1',
			evmWalletId: 'wallet-1',
			caip2Network: source.network,
			asset: source.asset,
			remainingAmount: '100',
		});

		expect(result.asset).toBe(source.asset.toLowerCase());
		expect(mockBudgetUpsert).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					apiKeyId_evmWalletId_asset: {
						apiKeyId: 'api-key-1',
						evmWalletId: 'wallet-1',
						asset: source.asset.toLowerCase(),
					},
				},
				create: expect.objectContaining({
					asset: source.asset.toLowerCase(),
				}),
			}),
		);
	});

	it('rejects setting a budget whose caip2Network does not match the wallet network with a 400', async () => {
		await expect(
			service.setX402WalletBudget({
				apiKeyId: 'api-key-1',
				evmWalletId: 'wallet-1',
				// The wallet is bound to source.network; a different chain must be rejected.
				caip2Network: 'eip155:1',
				asset: source.asset,
				remainingAmount: '100',
			}),
		).rejects.toMatchObject({ status: 400 });
		expect(mockBudgetUpsert).not.toHaveBeenCalled();
	});

	it('rejects setting a budget for a missing wallet with a 404', async () => {
		mockX402EvmWalletFindUnique.mockResolvedValueOnce(null);
		await expect(
			service.setX402WalletBudget({
				apiKeyId: 'api-key-1',
				evmWalletId: 'missing-wallet',
				caip2Network: source.network,
				asset: source.asset,
				remainingAmount: '100',
			}),
		).rejects.toMatchObject({ status: 404 });
		expect(mockBudgetUpsert).not.toHaveBeenCalled();
	});

	it('maps a duplicate managed wallet address to a 409', async () => {
		mockX402EvmWalletCreate.mockRejectedValueOnce(
			new MockPrismaClientKnownRequestError('Unique constraint failed on the fields: (`address`)', 'P2002'),
		);
		await expect(
			service.createX402ManagedWallet({
				createdByApiKeyId: 'api-key-1',
				networkId: 'network-1',
				type: 'Purchasing' as Parameters<typeof service.createX402ManagedWallet>[0]['type'],
				privateKey: `0x${'a'.repeat(64)}`,
			}),
		).rejects.toMatchObject({ status: 409 });
	});

	it('returns the generated private key once when no key is supplied', async () => {
		const result = await service.createX402ManagedWallet({
			createdByApiKeyId: 'api-key-1',
			networkId: 'network-1',
			type: 'Purchasing' as Parameters<typeof service.createX402ManagedWallet>[0]['type'],
		});
		// generatePrivateKey is mocked to a fixed 0xbb… key; it must be surfaced for backup.
		expect(result.privateKey).toBe(`0x${'b'.repeat(64)}`);
	});

	it('does not echo back a caller-supplied private key', async () => {
		const result = await service.createX402ManagedWallet({
			createdByApiKeyId: 'api-key-1',
			networkId: 'network-1',
			type: 'Purchasing' as Parameters<typeof service.createX402ManagedWallet>[0]['type'],
			privateKey: `0x${'a'.repeat(64)}`,
		});
		expect(result.privateKey).toBeNull();
	});

	it('refuses to settle through a retired facilitator wallet', async () => {
		mockX402NetworkFindUnique.mockResolvedValueOnce({
			id: 'network-1',
			caip2Id: source.network,
			displayName: 'Base Sepolia',
			rpcUrl: 'https://sepolia.base.org',
			isEnabled: true,
			FacilitatorWallet: {
				id: 'wallet-facilitator',
				type: 'Selling',
				encryptedPrivateKey: 'encrypted-private-key',
				deletedAt: new Date('2026-01-01T00:00:00.000Z'),
			},
		});
		await expect(
			service.settleX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: null,
				supportedPaymentSourceId: 'source-1',
				paymentPayload: typedPaymentPayload,
			}),
		).rejects.toMatchObject({ status: 400 });
		expect(mockFacilitatorSettle).not.toHaveBeenCalled();
	});

	it('refuses to settle through a facilitator wallet that is not a Selling wallet', async () => {
		mockX402NetworkFindUnique.mockResolvedValueOnce({
			id: 'network-1',
			caip2Id: source.network,
			displayName: 'Base Sepolia',
			rpcUrl: 'https://sepolia.base.org',
			isEnabled: true,
			FacilitatorWallet: {
				id: 'wallet-facilitator',
				type: 'Purchasing',
				encryptedPrivateKey: 'encrypted-private-key',
				deletedAt: null,
			},
		});
		await expect(
			service.settleX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: null,
				supportedPaymentSourceId: 'source-1',
				paymentPayload: typedPaymentPayload,
			}),
		).rejects.toMatchObject({ status: 400 });
		expect(mockFacilitatorSettle).not.toHaveBeenCalled();
	});

	it('records the error and re-throws (no auto-fail) when facilitator.settle throws', async () => {
		mockX402PaymentAttemptFindFirst.mockResolvedValue(null);
		mockFacilitatorSettle.mockRejectedValueOnce(new Error('rpc getCode failed'));

		await expect(
			service.settleX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: [source.network],
				supportedPaymentSourceId: source.id,
				paymentPayload: typedPaymentPayload,
			}),
		).rejects.toThrow('rpc getCode failed');

		// The pre-settle Verified marker is stamped with the error for diagnosis,
		// NOT auto-failed (auto-failing could tell a possibly-charged buyer "failed"
		// after a post-broadcast throw). The row stays Verified for reconciliation.
		expect(mockX402PaymentAttemptUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: 'attempt-1', status: 'Verified' },
				data: {
					errorReason: 'settle_threw',
					errorMessage: 'rpc getCode failed',
					updatedAt: new Date('2026-07-16T12:00:00.000Z'),
				},
			}),
		);
		// The call may have broadcast before throwing. Refresh and retain the wallet lease rather
		// than immediately exposing the signer nonce to another settlement.
		const leaseUpdates = (mockQueryRaw.mock.calls as Array<[readonly string[], ...unknown[]]>).filter(([parts]) =>
			parts.join('').includes('UPDATE "X402EvmWallet"'),
		);
		expect(leaseUpdates).toHaveLength(2); // acquire + ambiguous-error retention renew
		expect(mockX402EvmWalletUpdateMany).not.toHaveBeenCalled();
		// No settlement row is written when settle throws.
		expect(mockX402SettlementCreate).not.toHaveBeenCalled();
	});

	it('rejects a settlement payload already owned by another attempt without marking this attempt Settled', async () => {
		mockX402SettlementCreate.mockRejectedValueOnce(
			new MockPrismaClientKnownRequestError('Unique constraint failed on paymentPayloadHash', 'P2002'),
		);

		await expect(
			service.settleX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: [source.network],
				supportedPaymentSourceId: source.id,
				paymentPayload: typedPaymentPayload,
			}),
		).rejects.toMatchObject({ status: 409 });

		// The status claim and unique settlement insert share one transaction, so P2002 rolls the
		// status change back instead of exposing a settlement-less Settled attempt.
		expect(mockX402PaymentAttemptUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: 'attempt-1', status: 'Verified' },
				data: expect.objectContaining({ status: 'Settled' }),
			}),
		);
	});

	it('maps an adapter-pg settlement uniqueness error to 409', async () => {
		const error = new Error('duplicate key value violates unique constraint') as Error & {
			name: string;
			cause?: { code: string };
		};
		error.name = 'DriverAdapterError';
		error.cause = { code: '23505' };
		mockX402SettlementCreate.mockRejectedValueOnce(error);

		await expect(
			service.settleX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: [source.network],
				supportedPaymentSourceId: source.id,
				paymentPayload: typedPaymentPayload,
			}),
		).rejects.toMatchObject({ status: 409 });
	});

	it('retries a transient adapter deadlock while persisting a successful settlement', async () => {
		const error = new Error('deadlock detected') as Error & {
			name: string;
			cause?: { code: string };
		};
		error.name = 'DriverAdapterError';
		error.cause = { code: '40P01' };
		mockX402SettlementCreate.mockRejectedValueOnce(error);

		await expect(
			service.settleX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: [source.network],
				supportedPaymentSourceId: source.id,
				paymentPayload: typedPaymentPayload,
			}),
		).resolves.toMatchObject({
			replay: false,
			settleResponse: { success: true, transaction: '0xsettlement' },
		});

		expect(mockX402SettlementCreate).toHaveBeenCalledTimes(2);
		expect(mockX402PaymentAttemptUpdateMany).not.toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ errorReason: 'settle_persist_failed' }),
			}),
		);
	});

	it('returns the committed settlement when the transaction reports an error after commit', async () => {
		const runTransaction = mockPrismaTransaction.getMockImplementation();
		if (runTransaction == null) throw new Error('missing transaction mock implementation');
		let transactionCalls = 0;
		mockPrismaTransaction.mockImplementation(async (...args: unknown[]) => {
			transactionCalls += 1;
			const result = await runTransaction(...args);
			if (transactionCalls === 2) {
				throw new Error('connection lost after commit');
			}
			return result;
		});
		mockX402PaymentAttemptUpdateMany.mockImplementation(async (args: any) => ({
			count: args.data?.errorReason === 'settle_persist_failed' ? 0 : 1,
		}));
		mockX402SettlementFindUnique
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({ paymentAttemptId: 'attempt-1', txHash: '0xsettlement' });

		await expect(
			service.settleX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: [source.network],
				supportedPaymentSourceId: source.id,
				paymentPayload: typedPaymentPayload,
			}),
		).resolves.toMatchObject({
			replay: false,
			settleResponse: { success: true, transaction: '0xsettlement' },
			webhook: { success: true, txHash: '0xsettlement' },
		});

		expect(mockFacilitatorSettle).toHaveBeenCalledTimes(1);
		expect(mockX402SettlementCreate).toHaveBeenCalledTimes(1);
	});

	it('maps the database active-claim unique constraint to 409 before settling', async () => {
		// An older replica that does not take the payload claim races its marker create past
		// the guard; the partial unique index rejects ours. No authorization was submitted,
		// so the caller gets the same 409 as the in-claim guard and can retry cleanly.
		mockX402PaymentAttemptCreate.mockRejectedValueOnce(
			new MockPrismaClientKnownRequestError(
				'Unique constraint failed on X402PaymentAttempt_active_settlement_payload_key',
				'P2002',
			),
		);

		await expect(
			service.settleX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: [source.network],
				supportedPaymentSourceId: source.id,
				paymentPayload: typedPaymentPayload,
			}),
		).rejects.toMatchObject({ status: 409 });

		expect(mockFacilitatorSettle).not.toHaveBeenCalled();
		// No marker of ours exists, so nothing may be error-stamped.
		expect(mockX402PaymentAttemptUpdate).not.toHaveBeenCalled();
	});

	it('maps an adapter-pg active-claim 23505 to 409 before settling', async () => {
		const error = new Error('duplicate key value violates unique constraint') as Error & { code?: string };
		error.code = '23505';
		mockX402PaymentAttemptCreate.mockRejectedValueOnce(error);

		await expect(
			service.settleX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: [source.network],
				supportedPaymentSourceId: source.id,
				paymentPayload: typedPaymentPayload,
			}),
		).rejects.toMatchObject({ status: 409 });

		expect(mockFacilitatorSettle).not.toHaveBeenCalled();
	});

	it('stamps settle_persist_failed with the txHash when persisting a successful outcome fails', async () => {
		mockX402SettlementCreate.mockRejectedValueOnce(new Error('connection reset'));

		await expect(
			service.settleX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: [source.network],
				supportedPaymentSourceId: source.id,
				paymentPayload: typedPaymentPayload,
			}),
		).rejects.toThrow('connection reset');

		// Funds moved but the receipt could not be persisted: the marker keeps its Verified
		// status (never auto-fail) and is stamped with the reason plus the on-chain txHash so
		// it enters the needs-manual-action backlog once stale with the operator's reference.
		expect(mockX402PaymentAttemptUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: 'attempt-1', status: 'Verified' },
				data: expect.objectContaining({
					errorReason: 'settle_persist_failed',
					errorMessage: expect.stringContaining('txHash=0xsettlement'),
					updatedAt: new Date('2026-07-16T12:00:00.000Z'),
				}),
			}),
		);
		expect(mockX402PaymentAttemptUpdateMany).not.toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: 'Failed' }) }),
		);
	});

	it('does not overwrite a concurrent manual resolution after the facilitator returns success', async () => {
		mockX402PaymentAttemptUpdateMany.mockResolvedValueOnce({ count: 0 });

		await expect(
			service.settleX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: [source.network],
				supportedPaymentSourceId: source.id,
				paymentPayload: typedPaymentPayload,
			}),
		).rejects.toMatchObject({ status: 409 });

		expect(mockX402SettlementCreate).not.toHaveBeenCalled();
	});

	it('does not overwrite a concurrent manual resolution after the facilitator returns failure', async () => {
		mockFacilitatorSettle.mockResolvedValueOnce({
			success: false,
			network: source.network,
			errorReason: 'invalid_payment',
			errorMessage: 'authorization rejected',
		});
		mockX402PaymentAttemptUpdateMany.mockResolvedValueOnce({ count: 0 });

		await expect(
			service.settleX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: [source.network],
				supportedPaymentSourceId: source.id,
				paymentPayload: typedPaymentPayload,
			}),
		).rejects.toMatchObject({ status: 409 });

		expect(mockX402SettlementCreate).not.toHaveBeenCalled();
	});

	it('rejects granting a budget to a Selling wallet', async () => {
		mockX402EvmWalletFindUnique.mockResolvedValueOnce({
			id: 'wallet-selling',
			address: '0xcccccccccccccccccccccccccccccccccccccccc',
			type: 'Selling',
			encryptedPrivateKey: 'encrypted-private-key',
			deletedAt: null,
		});
		await expect(
			service.setX402WalletBudget({
				apiKeyId: 'api-key-1',
				evmWalletId: 'wallet-selling',
				caip2Network: source.network,
				asset: source.asset,
				remainingAmount: '100',
			}),
		).rejects.toMatchObject({ status: 400 });
		expect(mockBudgetUpsert).not.toHaveBeenCalled();
	});

	describe('createX402Payment (buy side)', () => {
		it('signs a forwarded 402 with a managed wallet and returns the X-PAYMENT header', async () => {
			const result = await service.createX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: [source.network],
				evmWalletId: 'wallet-1',
				paymentRequired,
			});

			expect(result).toMatchObject({
				attemptId: 'attempt-outbound-1',
				payer: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				caip2Network: source.network,
				asset: source.asset.toLowerCase(),
				amount: requirements.amount,
				payTo: source.payTo.toLowerCase(),
				xPaymentHeader: 'x-payment-header-base64',
				paymentPayloadHash: service.hashX402PaymentPayload(paymentPayload),
				paymentIdentifier: null,
			});

			// Budget atomically debited, attempt recorded as an outbound payment.
			expect(mockBudgetUpdateMany).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({
						id: 'budget-1',
						generation: 0,
						remainingAmount: { gte: source.amount },
					}),
					data: { remainingAmount: { decrement: source.amount }, spentAmount: { increment: source.amount } },
				}),
			);
			expect(mockTxPaymentAttemptCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({ direction: 'OutboundPayment', asset: source.asset.toLowerCase() }),
				}),
			);
			expect(mockCreatePaymentPayload).toHaveBeenCalledWith(paymentRequired);
			expect(mockX402PaymentAttemptUpdate).toHaveBeenCalledWith(
				expect.objectContaining({
					where: { id: 'attempt-outbound-1' },
					data: expect.objectContaining({ status: 'Verified' }),
				}),
			);
			// The service never fetches the resource.
			expect(mockBudgetUpdate).not.toHaveBeenCalled();
		});

		it('pins the client policy to the single budgeted requirement', async () => {
			await service.createX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: [source.network],
				evmWalletId: 'wallet-1',
				paymentRequired,
			});

			const foreignRequirement = { ...requirements, payTo: '0x9999999999999999999999999999999999999999' };
			expect(latestClient?.policies).toHaveLength(1);
			expect(latestClient?.policies[0](2, [requirements, foreignRequirement])).toEqual([requirements]);
		});

		it('rejects when no accepts entry matches an allowed network', async () => {
			await expect(
				service.createX402Payment({
					apiKeyId: 'api-key-1',
					caip2NetworkLimit: ['eip155:1'],
					evmWalletId: 'wallet-1',
					paymentRequired,
				}),
			).rejects.toMatchObject({ status: 400 });

			expect(mockBudgetUpdateMany).not.toHaveBeenCalled();
			expect(mockCreatePaymentPayload).not.toHaveBeenCalled();
		});

		it('rejects when a delegated managed-wallet budget cannot cover the requirement', async () => {
			mockBudgetFindFirst.mockResolvedValue({ id: 'budget-1', remainingAmount: 1n, generation: 0 });

			await expect(
				service.createX402Payment({
					apiKeyId: 'api-key-2',
					caip2NetworkLimit: [source.network],
					evmWalletId: 'wallet-1',
					paymentRequired,
					ownerScope: 'api-key-2',
				}),
			).rejects.toMatchObject({ status: 402 });

			expect(mockCreatePaymentPayload).not.toHaveBeenCalled();
		});

		it('signs uncapped when a self-owned wallet has no budget (client meters spend off-node)', async () => {
			// The caller owns the wallet (createdById === apiKeyId) and no budget is configured, so
			// the node applies no cap — the on-chain balance is the only ceiling and no budget row
			// is touched.
			mockX402EvmWalletFindUnique.mockResolvedValue({
				id: 'wallet-1',
				networkId: 'network-1',
				secretId: 'secret-1',
				address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				type: 'Purchasing',
				createdById: 'api-key-1',
				deletedAt: null,
				Secret: { encryptedPrivateKey: 'encrypted-private-key' },
				Network: {
					id: 'network-1',
					caip2Id: source.network,
					rpcUrl: 'https://sepolia.base.org',
					displayName: 'Base Sepolia',
				},
			});
			mockBudgetFindFirst.mockResolvedValue(null);

			const result = await service.createX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: [source.network],
				evmWalletId: 'wallet-1',
				paymentRequired,
				ownerScope: 'api-key-1',
			});

			expect(result).toMatchObject({ attemptId: 'attempt-outbound-1' });
			expect(mockCreatePaymentPayload).toHaveBeenCalled();
			// Uncapped path debits no budget.
			expect(mockBudgetUpdateMany).not.toHaveBeenCalled();
		});

		it('rejects a scoped caller spending a wallet it does not own (404)', async () => {
			// The wallet was created by 'api-key-1'; a different scoped key must not address it.
			mockX402EvmWalletFindUnique.mockResolvedValueOnce({
				id: 'wallet-1',
				networkId: 'network-1',
				secretId: 'secret-1',
				address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				type: 'Purchasing',
				createdById: 'api-key-1',
				deletedAt: null,
			});
			mockBudgetFindFirst.mockResolvedValue(null);

			await expect(
				service.createX402Payment({
					apiKeyId: 'api-key-2',
					caip2NetworkLimit: [source.network],
					evmWalletId: 'wallet-1',
					paymentRequired,
					ownerScope: 'api-key-2',
				}),
			).rejects.toMatchObject({ status: 404 });

			expect(mockCreatePaymentPayload).not.toHaveBeenCalled();
		});

		it('hides a foreign wrong-type wallet when the caller has no budget grant', async () => {
			mockX402EvmWalletFindUnique.mockResolvedValue({
				id: 'wallet-selling',
				networkId: 'network-1',
				address: '0xcccccccccccccccccccccccccccccccccccccccc',
				type: 'Selling',
				createdById: 'api-key-1',
				deletedAt: null,
			});
			mockBudgetFindFirst.mockResolvedValue(null);

			await expect(
				service.createX402Payment({
					apiKeyId: 'api-key-2',
					caip2NetworkLimit: [source.network],
					evmWalletId: 'wallet-selling',
					paymentRequired,
					ownerScope: 'api-key-2',
				}),
			).rejects.toMatchObject({ status: 404 });

			expect(mockCreatePaymentPayload).not.toHaveBeenCalled();
		});

		it('allows a scoped caller to spend a delegated wallet through its matching budget', async () => {
			// Legacy and operator-managed wallets can belong to a different API key; the budget is
			// the explicit, capped delegation that authorizes this grantee to sign with it.
			mockX402EvmWalletFindUnique.mockResolvedValue({
				id: 'wallet-1',
				networkId: 'network-1',
				secretId: 'secret-1',
				address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				type: 'Purchasing',
				createdById: 'admin-key-1',
				deletedAt: null,
				Secret: { encryptedPrivateKey: 'encrypted-private-key' },
				Network: {
					id: 'network-1',
					caip2Id: source.network,
					rpcUrl: 'https://sepolia.base.org',
					displayName: 'Base Sepolia',
				},
			});

			const result = await service.createX402Payment({
				apiKeyId: 'api-key-2',
				caip2NetworkLimit: [source.network],
				evmWalletId: 'wallet-1',
				paymentRequired,
				ownerScope: 'api-key-2',
			});

			expect(result).toMatchObject({ attemptId: 'attempt-outbound-1' });
			expect(mockBudgetFindFirst).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({
						apiKeyId: 'api-key-2',
						evmWalletId: 'wallet-1',
						asset: source.asset.toLowerCase(),
						enabled: true,
					}),
					select: expect.objectContaining({ generation: true }),
				}),
			);
			expect(mockBudgetUpdateMany).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({
						id: 'budget-1',
						apiKeyId: 'api-key-2',
						evmWalletId: 'wallet-1',
						asset: source.asset.toLowerCase(),
						generation: 0,
						enabled: true,
					}),
				}),
			);
		});

		it('rejects when the on-chain balance cannot cover the payment (402)', async () => {
			// Budget selection passes, but the wallet's on-chain balance is below the amount, so the
			// payment is refused before signing and no budget is debited.
			mockReadContract.mockResolvedValue(1n);

			await expect(
				service.createX402Payment({
					apiKeyId: 'api-key-1',
					caip2NetworkLimit: [source.network],
					evmWalletId: 'wallet-1',
					paymentRequired,
				}),
			).rejects.toMatchObject({ status: 402 });

			expect(mockCreatePaymentPayload).not.toHaveBeenCalled();
		});

		it('rejects signing an outbound payment with a Selling wallet', async () => {
			// A funded budget exists, but the wallet itself is a Selling wallet, so the
			// payment must be refused before signing.
			mockX402EvmWalletFindUnique.mockResolvedValue({
				id: 'wallet-1',
				address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				type: 'Selling',
				encryptedPrivateKey: 'encrypted-private-key',
				deletedAt: null,
			});

			await expect(
				service.createX402Payment({
					apiKeyId: 'api-key-1',
					caip2NetworkLimit: [source.network],
					evmWalletId: 'wallet-1',
					paymentRequired,
				}),
			).rejects.toMatchObject({ status: 400 });

			expect(mockCreatePaymentPayload).not.toHaveBeenCalled();
		});

		it.each([['-1000'], ['0'], ['1.5'], ['abc'], [''], ['9223372036854775808']])(
			'rejects a forwarded requirement with a non-positive/malformed amount %p without touching the budget',
			async (amount) => {
				await expect(
					service.createX402Payment({
						apiKeyId: 'api-key-1',
						caip2NetworkLimit: [source.network],
						evmWalletId: 'wallet-1',
						paymentRequired: {
							...paymentRequired,
							accepts: [{ ...requirements, amount }],
						} as Parameters<typeof service.createX402Payment>[0]['paymentRequired'],
					}),
				).rejects.toMatchObject({ status: 400 });

				expect(mockBudgetUpdateMany).not.toHaveBeenCalled();
				expect(mockCreatePaymentPayload).not.toHaveBeenCalled();
			},
		);

		it('allows an admin to spend another owner wallet uncapped when no budget exists', async () => {
			mockX402EvmWalletFindUnique.mockResolvedValue({
				id: 'wallet-1',
				networkId: 'network-1',
				secretId: 'secret-1',
				address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				type: 'Purchasing',
				createdById: 'api-key-2',
				deletedAt: null,
				Secret: { encryptedPrivateKey: 'encrypted-private-key' },
				Network: {
					id: 'network-1',
					caip2Id: source.network,
					rpcUrl: 'https://sepolia.base.org',
					displayName: 'Base Sepolia',
				},
			});
			mockBudgetFindFirst.mockResolvedValue(null);

			const result = await service.createX402Payment({
				apiKeyId: 'admin-key-1',
				caip2NetworkLimit: null,
				evmWalletId: 'wallet-1',
				paymentRequired,
			});

			expect(result.xPaymentHeader).toBe('x-payment-header-base64');
			expect(mockBudgetUpdateMany).not.toHaveBeenCalled();
		});

		it('refunds the reserved budget and fails the attempt when signing throws', async () => {
			mockCreatePaymentPayload.mockRejectedValue(new Error('sign boom'));

			// The raw signing error (which can embed the configured RPC URL) is sanitized
			// into a generic HttpError so internals never reach the caller.
			await expect(
				service.createX402Payment({
					apiKeyId: 'api-key-1',
					caip2NetworkLimit: [source.network],
					evmWalletId: 'wallet-1',
					paymentRequired,
				}),
			).rejects.toMatchObject({ status: 500, message: 'x402 payment signing failed' });

			expect(mockX402PaymentAttemptUpdate).toHaveBeenCalledWith(
				expect.objectContaining({
					where: { id: 'attempt-outbound-1' },
					data: expect.objectContaining({ status: 'Failed', errorReason: 'x402_sign_failed' }),
				}),
			);
			expect(mockBudgetRefundUpdateMany).toHaveBeenCalledWith({
				where: { id: 'budget-1', generation: 0, spentAmount: { gte: source.amount } },
				data: {
					remainingAmount: { increment: source.amount },
					spentAmount: { decrement: source.amount },
				},
			});
		});

		it('rejects (and refunds) when a paymentIdentifier is requested but the 402 does not support it', async () => {
			// The forwarded 402 declares no payment-identifier extension, and the mock
			// extractor returns id:null, so the requested identifier cannot be attached.
			await expect(
				service.createX402Payment({
					apiKeyId: 'api-key-1',
					caip2NetworkLimit: [source.network],
					evmWalletId: 'wallet-1',
					paymentRequired,
					paymentIdentifier: 'caller-supplied-id-123456',
				}),
			).rejects.toMatchObject({ status: 400 });

			// Budget was reserved then refunded (refund runs before the best-effort status update).
			expect(mockBudgetRefundUpdateMany).toHaveBeenCalledWith({
				where: { id: 'budget-1', generation: 0, spentAmount: { gte: source.amount } },
				data: {
					remainingAmount: { increment: source.amount },
					spentAmount: { decrement: source.amount },
				},
			});
		});

		it('does not refund an old reservation into a reset generation after a newer spend', async () => {
			const amount = BigInt(requirements.amount);
			const freshGrant = amount * 3n;
			const budgetState = {
				remainingAmount: amount * 5n,
				spentAmount: 0n,
				generation: 0,
			};

			mockBudgetFindFirst.mockImplementation(async () => ({
				id: 'budget-1',
				remainingAmount: budgetState.remainingAmount,
				generation: budgetState.generation,
			}));
			mockBudgetUpdateMany.mockImplementation(async (args: any) => {
				const generationMatches =
					args.where.generation === undefined || args.where.generation === budgetState.generation;
				const minimum = args.where.remainingAmount.gte as bigint;
				if (!generationMatches || budgetState.remainingAmount < minimum) return { count: 0 };
				const reservedAmount = args.data.remainingAmount.decrement as bigint;
				budgetState.remainingAmount -= reservedAmount;
				budgetState.spentAmount += reservedAmount;
				return { count: 1 };
			});
			mockBudgetRefundUpdateMany.mockImplementation(async (args: any) => {
				// Undefined models the pre-generation query: it would match whichever grant is current.
				const generationMatches =
					args.where.generation === undefined || args.where.generation === budgetState.generation;
				const minimum = args.where.spentAmount.gte as bigint;
				if (!generationMatches || budgetState.spentAmount < minimum) return { count: 0 };
				const refundedAmount = args.data.remainingAmount.increment as bigint;
				budgetState.remainingAmount += refundedAmount;
				budgetState.spentAmount -= refundedAmount;
				return { count: 1 };
			});
			mockBudgetUpsert.mockImplementation(async (args: any) => {
				budgetState.remainingAmount = args.update.remainingAmount as bigint;
				budgetState.spentAmount = args.update.spentAmount as bigint;
				budgetState.generation += args.update.generation.increment as number;
				return {
					id: 'budget-1',
					apiKeyId: 'api-key-1',
					evmWalletId: 'wallet-1',
					asset: source.asset.toLowerCase(),
					remainingAmount: budgetState.remainingAmount,
					spentAmount: budgetState.spentAmount,
					createdById: 'admin-key-1',
					createdAt: new Date('2026-01-01T00:00:00.000Z'),
					updatedAt: new Date('2026-01-01T00:00:00.000Z'),
					EvmWallet: {
						address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
						Network: { caip2Id: source.network },
					},
				};
			});

			let markFirstSigningStarted!: () => void;
			const firstSigningStarted = new Promise<void>((resolve) => {
				markFirstSigningStarted = resolve;
			});
			let rejectFirstSigning!: (reason: Error) => void;
			mockCreatePaymentPayload
				.mockImplementationOnce(
					() =>
						new Promise((_resolve, reject) => {
							rejectFirstSigning = reject;
							markFirstSigningStarted();
						}),
				)
				.mockResolvedValueOnce(paymentPayload);

			const firstPayment = service.createX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: [source.network],
				evmWalletId: 'wallet-1',
				paymentRequired,
			});
			const firstFailure = expect(firstPayment).rejects.toMatchObject({ status: 500 });
			await firstSigningStarted;
			expect(budgetState).toEqual({
				remainingAmount: amount * 4n,
				spentAmount: amount,
				generation: 0,
			});

			await service.setX402WalletBudget({
				apiKeyId: 'api-key-1',
				evmWalletId: 'wallet-1',
				caip2Network: source.network,
				asset: source.asset,
				remainingAmount: freshGrant.toString(),
				createdById: 'admin-key-1',
			});
			expect(budgetState).toEqual({ remainingAmount: freshGrant, spentAmount: 0n, generation: 1 });

			await service.createX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: [source.network],
				evmWalletId: 'wallet-1',
				paymentRequired,
			});
			expect(budgetState).toEqual({
				remainingAmount: freshGrant - amount,
				spentAmount: amount,
				generation: 1,
			});

			rejectFirstSigning(new Error('first signing failed'));
			await firstFailure;
			expect(budgetState).toEqual({
				remainingAmount: freshGrant - amount,
				spentAmount: amount,
				generation: 1,
			});
			expect(mockBudgetRefundUpdateMany).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({ id: 'budget-1', generation: 0 }),
				}),
			);
			expect(mockBudgetUpdateMany.mock.calls.map(([args]) => (args as any).where.generation)).toEqual([0, 1]);
		});

		it('records the initiating API key as createdById on the budget', async () => {
			await service.setX402WalletBudget({
				apiKeyId: 'api-key-1',
				evmWalletId: 'wallet-1',
				caip2Network: source.network,
				asset: source.asset,
				remainingAmount: '100',
				createdById: 'admin-key-1',
			});

			expect(mockBudgetUpsert).toHaveBeenCalledWith(
				expect.objectContaining({
					create: expect.objectContaining({ createdById: 'admin-key-1' }),
					update: expect.objectContaining({ generation: { increment: 1 } }),
				}),
			);
		});
	});

	describe('facilitator + counterparty modelling', () => {
		it('rejects a network row with both remote and self-hosted facilitators', async () => {
			mockX402NetworkFindUnique.mockResolvedValue({
				id: 'network-1',
				caip2Id: source.network,
				displayName: 'Base Sepolia',
				rpcUrl: 'https://sepolia.base.org',
				isEnabled: true,
				updatedAt: networkUpdatedAt,
				facilitatorWalletId: 'wallet-facilitator',
				facilitatorUrl: 'https://facilitator.example',
				facilitatorAuthEnc: null,
				FacilitatorWallet: {
					id: 'wallet-facilitator',
					type: 'Selling',
					deletedAt: null,
					Secret: { encryptedPrivateKey: 'encrypted-private-key' },
				},
			});

			await expect(
				service.settleX402Payment({
					apiKeyId: 'api-key-1',
					caip2NetworkLimit: [source.network],
					supportedPaymentSourceId: source.id,
					paymentPayload: typedPaymentPayload,
				}),
			).rejects.toMatchObject({
				status: 500,
				message: 'x402 network has conflicting facilitator configuration',
			});
			expect(mockFacilitatorSettle).not.toHaveBeenCalled();
		});

		it('settles through a remote facilitator (facilitatorUrl) with no owned wallet', async () => {
			mockX402NetworkFindUnique.mockResolvedValue({
				id: 'network-1',
				caip2Id: source.network,
				displayName: 'Base Sepolia',
				rpcUrl: 'https://sepolia.base.org',
				isEnabled: true,
				updatedAt: networkUpdatedAt,
				facilitatorWalletId: null,
				facilitatorUrl: 'https://facilitator.example',
				facilitatorAuthEnc: null,
				FacilitatorWallet: null,
			});
			mockTxX402NetworkFindUnique.mockResolvedValue({
				isEnabled: true,
				updatedAt: networkUpdatedAt,
				rpcUrl: 'https://sepolia.base.org',
				facilitatorWalletId: null,
				facilitatorUrl: 'https://facilitator.example',
				facilitatorAuthEnc: null,
			});

			const result = await service.settleX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: [source.network],
				supportedPaymentSourceId: source.id,
				paymentPayload: typedPaymentPayload,
			});

			expect(result.settleResponse.success).toBe(true);
			expect(mockFacilitatorSettle).toHaveBeenCalled();
			// A remote-facilitator network owns no key, so the inbound attempt has no wallet.
			expect(mockX402PaymentAttemptCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						createdAt: new Date('2026-07-16T12:00:00.000Z'),
						updatedAt: new Date('2026-07-16T12:00:00.000Z'),
						direction: 'InboundSettle',
						evmWalletId: null,
						facilitatorMode: 'Remote',
						networkId: 'network-1',
					}),
				}),
			);
		});

		it('binds the self-hosted facilitator wallet to the inbound settle attempt', async () => {
			await service.settleX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: [source.network],
				supportedPaymentSourceId: source.id,
				paymentPayload: typedPaymentPayload,
			});

			expect(mockX402PaymentAttemptCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						direction: 'InboundSettle',
						evmWalletId: 'wallet-facilitator',
						facilitatorMode: 'SelfHosted',
						payTo: source.payTo.toLowerCase(),
					}),
				}),
			);
		});

		it('records the buyer as a Payer counterparty on verify', async () => {
			await service.verifyX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: [source.network],
				supportedPaymentSourceId: source.id,
				paymentPayload: typedPaymentPayload,
			});

			expect(mockCounterpartyFindUniqueOrThrow).toHaveBeenCalledWith(
				expect.objectContaining({
					where: {
						caip2Network_address_role: {
							caip2Network: source.network,
							address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
							role: 'Payer',
						},
					},
				}),
			);
			expect(mockX402PaymentAttemptCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						direction: 'InboundVerify',
						counterpartyWalletId: 'counterparty-1',
						facilitatorMode: 'SelfHosted',
						networkId: 'network-1',
						payTo: source.payTo.toLowerCase(),
					}),
				}),
			);
		});

		it('records the payee (payTo) as a Payee counterparty on an outbound payment', async () => {
			await service.createX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: [source.network],
				evmWalletId: 'wallet-1',
				paymentRequired,
			});

			expect(mockCounterpartyFindUniqueOrThrow).toHaveBeenCalledWith(
				expect.objectContaining({
					where: {
						caip2Network_address_role: {
							caip2Network: source.network,
							address: source.payTo.toLowerCase(),
							role: 'Payee',
						},
					},
				}),
			);
			expect(mockTxPaymentAttemptCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({ payTo: source.payTo.toLowerCase() }),
				}),
			);
		});
	});

	describe('upsertX402Network facilitator validation', () => {
		it('rejects configuring both a facilitator wallet and a facilitator URL', async () => {
			await expect(
				service.upsertX402Network({
					caip2Id: source.network,
					displayName: 'Base Sepolia',
					rpcUrl: 'https://sepolia.base.org',
					facilitatorWalletId: 'wallet-facilitator',
					facilitatorUrl: 'https://facilitator.example',
				}),
			).rejects.toMatchObject({ status: 400 });
		});

		it('rejects a plaintext remote facilitator URL', async () => {
			await expect(
				service.upsertX402Network({
					caip2Id: source.network,
					displayName: 'Base Sepolia',
					rpcUrl: 'https://sepolia.base.org',
					facilitatorUrl: 'http://facilitator.example',
				}),
			).rejects.toMatchObject({ status: 400 });
			expect(mockX402NetworkUpsert).not.toHaveBeenCalled();
		});

		it('rejects a facilitator wallet bound to a different network', async () => {
			// A Selling wallet exists, but it is bound to eip155:1, not the configured chain.
			mockX402EvmWalletFindUnique.mockResolvedValueOnce({
				id: 'wallet-facilitator',
				type: 'Selling',
				Network: { caip2Id: 'eip155:1' },
			});
			await expect(
				service.upsertX402Network({
					caip2Id: source.network,
					displayName: 'Base Sepolia',
					rpcUrl: 'https://sepolia.base.org',
					facilitatorWalletId: 'wallet-facilitator',
				}),
			).rejects.toMatchObject({ status: 400 });
		});

		// clearAllMocks runs before each test, so exactly one upsert call is recorded per case.
		const upsertUpdateArg = () =>
			(mockX402NetworkUpsert.mock.calls[0][0] as { update: Record<string, unknown> }).update;
		const baseInput = { caip2Id: source.network, displayName: 'Base Sepolia', rpcUrl: 'https://sepolia.base.org' };

		it('requires operator-confirmed decimals when setting a default token', async () => {
			await expect(
				service.upsertX402Network({
					...baseInput,
					defaultAsset: '0x036CbD53842c5426634e7929541eC2318f3dCF7c',
				}),
			).rejects.toMatchObject({
				status: 400,
				message: 'defaultAssetDecimals is required when setting defaultAsset',
			});
			expect(mockX402NetworkUpsert).not.toHaveBeenCalled();
		});

		it('persists a default token together with its exact decimals', async () => {
			await service.upsertX402Network({
				...baseInput,
				defaultAsset: '0x036CbD53842c5426634e7929541eC2318f3dCF7c',
				defaultAssetDecimals: 6,
			});

			expect(upsertUpdateArg()).toMatchObject({
				defaultAsset: '0x036cbd53842c5426634e7929541ec2318f3dcf7c',
				defaultAssetDecimals: 6,
			});
		});

		it('requires fresh decimals when changing an existing default token', async () => {
			mockX402NetworkFindUnique.mockResolvedValueOnce({
				defaultAsset: '0x1111111111111111111111111111111111111111',
				defaultAssetDecimals: 6,
			});

			await expect(
				service.upsertX402Network({
					...baseInput,
					defaultAsset: '0x2222222222222222222222222222222222222222',
				}),
			).rejects.toMatchObject({
				status: 400,
				message: 'defaultAssetDecimals is required when setting defaultAsset',
			});
			expect(mockX402NetworkUpsert).not.toHaveBeenCalled();
		});

		it('preserves stored decimals when the default token address is unchanged', async () => {
			mockX402NetworkFindUnique.mockResolvedValueOnce({
				defaultAsset: '0x1111111111111111111111111111111111111111',
				defaultAssetDecimals: 6,
			});

			await service.upsertX402Network({
				...baseInput,
				defaultAsset: '0x1111111111111111111111111111111111111111',
			});

			expect(upsertUpdateArg()).toMatchObject({
				defaultAsset: '0x1111111111111111111111111111111111111111',
				defaultAssetDecimals: 6,
			});
		});

		it('clears stored decimals when a legacy client clears only the default token', async () => {
			mockX402NetworkFindUnique.mockResolvedValueOnce({
				defaultAsset: '0x1111111111111111111111111111111111111111',
				defaultAssetDecimals: 6,
			});

			await service.upsertX402Network({
				...baseInput,
				defaultAsset: null,
			});

			expect(upsertUpdateArg()).toMatchObject({
				defaultAsset: null,
				defaultAssetDecimals: null,
			});
		});

		it('clears default-token decimals when clearing the token', async () => {
			await service.upsertX402Network({
				...baseInput,
				defaultAsset: null,
				defaultAssetDecimals: null,
			});

			expect(upsertUpdateArg()).toMatchObject({
				defaultAsset: null,
				defaultAssetDecimals: null,
			});
		});

		it('leaves every facilitator column untouched on a metadata-only edit', async () => {
			await service.upsertX402Network({ ...baseInput, displayName: 'Renamed' });
			const update = upsertUpdateArg();
			expect(update).not.toHaveProperty('facilitatorWalletId');
			expect(update).not.toHaveProperty('facilitatorUrl');
			expect(update).not.toHaveProperty('facilitatorAuthEnc');
		});

		it('keeps stored auth for a same-origin remote URL edit without retyping auth', async () => {
			mockX402NetworkFindUnique.mockResolvedValueOnce({
				facilitatorUrl: 'https://facilitator.example/old',
				facilitatorAuthEnc: 'encrypted:Bearer old',
			});
			await service.upsertX402Network({ ...baseInput, facilitatorUrl: 'https://facilitator.example/new' });
			const update = upsertUpdateArg();
			expect(update.facilitatorUrl).toBe('https://facilitator.example/new');
			expect(update.facilitatorWalletId).toBeNull();
			expect(update.facilitatorAuthEnc).toBe('encrypted:Bearer old');
		});

		it('clears stored auth when the remote facilitator origin changes', async () => {
			mockX402NetworkFindUnique.mockResolvedValueOnce({ facilitatorUrl: 'https://facilitator.example/settle' });
			await service.upsertX402Network({ ...baseInput, facilitatorUrl: 'https://other.example/settle' });
			const update = upsertUpdateArg();
			expect(update.facilitatorUrl).toBe('https://other.example/settle');
			expect(update.facilitatorAuthEnc).toBeNull();
		});

		it('sets (rotates) the auth when a new value is provided with the URL', async () => {
			await service.upsertX402Network({
				...baseInput,
				facilitatorUrl: 'https://facilitator.example',
				facilitatorAuth: 'Bearer new',
			});
			expect(upsertUpdateArg().facilitatorAuthEnc).toBe('encrypted:Bearer new');
		});

		it('clears the auth when an explicit null is sent with the URL', async () => {
			await service.upsertX402Network({
				...baseInput,
				facilitatorUrl: 'https://facilitator.example',
				facilitatorAuth: null,
			});
			expect(upsertUpdateArg().facilitatorAuthEnc).toBeNull();
		});

		it('binds an auth-only rotation to the observed remote facilitator mode', async () => {
			mockX402NetworkFindUnique.mockResolvedValueOnce({ facilitatorUrl: 'https://facilitator.example' });
			await service.upsertX402Network({ ...baseInput, facilitatorAuth: 'Bearer rotated' });
			const update = upsertUpdateArg();
			expect(update.facilitatorAuthEnc).toBe('encrypted:Bearer rotated');
			// Explicitly snapshot the observed mode so a concurrent URL/wallet switch cannot cause
			// this old-origin credential to land on the replacement facilitator.
			expect(update.facilitatorUrl).toBe('https://facilitator.example');
			expect(update.facilitatorWalletId).toBeNull();
		});

		it('rejects an auth-only change when no remote facilitator URL is configured', async () => {
			// Default network mock has facilitatorUrl null → setting an auth header has nowhere to apply.
			mockX402NetworkFindUnique.mockResolvedValueOnce({ facilitatorUrl: null });
			await expect(service.upsertX402Network({ ...baseInput, facilitatorAuth: 'Bearer orphan' })).rejects.toMatchObject(
				{ status: 400 },
			);
			expect(mockX402NetworkUpsert).not.toHaveBeenCalled();
		});

		it('rejects an auth-only change for a legacy plaintext facilitator URL', async () => {
			mockX402NetworkFindUnique.mockResolvedValueOnce({ facilitatorUrl: 'http://facilitator.example' });
			await expect(
				service.upsertX402Network({ ...baseInput, facilitatorAuth: 'Bearer rotated' }),
			).rejects.toMatchObject({ status: 400 });
			expect(mockX402NetworkUpsert).not.toHaveBeenCalled();
		});

		it('detaches the facilitator when both selectors are explicitly null', async () => {
			await service.upsertX402Network({ ...baseInput, facilitatorWalletId: null, facilitatorUrl: null });
			const update = upsertUpdateArg();
			expect(update.facilitatorWalletId).toBeNull();
			expect(update.facilitatorUrl).toBeNull();
			expect(update.facilitatorAuthEnc).toBeNull();
		});

		it('clears a remote facilitator and its auth when only facilitatorUrl is null', async () => {
			await service.upsertX402Network({ ...baseInput, facilitatorUrl: null });
			const update = upsertUpdateArg();
			expect(update.facilitatorUrl).toBeNull();
			expect(update.facilitatorAuthEnc).toBeNull();
			expect(update).not.toHaveProperty('facilitatorWalletId');
		});

		it('clears a self-hosted facilitator when only facilitatorWalletId is null', async () => {
			await service.upsertX402Network({ ...baseInput, facilitatorWalletId: null });
			const update = upsertUpdateArg();
			expect(update.facilitatorWalletId).toBeNull();
			expect(update).not.toHaveProperty('facilitatorUrl');
			expect(update).not.toHaveProperty('facilitatorAuthEnc');
		});
	});

	describe('reconcileX402PaymentAttempt', () => {
		// Older than SETTLE_STALE_MS (300s): no live settle can still own an unrenewed row this old.
		const staleUpdatedAt = new Date(databaseClockNow.getTime() - 600_000);
		// The reconciliation backlog: an inbound settle left Verified with a recorded error.
		const backlogAttempt = {
			id: 'attempt-stuck',
			evmWalletId: 'wallet-facilitator',
			direction: 'InboundSettle',
			status: 'Verified',
			errorReason: 'settle_threw',
			errorMessage: 'rpc getCode failed',
			paymentPayloadHash: 'hash-1',
			updatedAt: staleUpdatedAt,
			// Fields the reconciliation webhook reads.
			supportedPaymentSourceId: source.id,
			registryRequestId: source.registryRequestId,
			asset: source.asset,
			amount: source.amount,
			payTo: source.payTo.toLowerCase(),
			Network: { caip2Id: source.network },
			EvmWallet: { lockedAt: null },
			CounterpartyWallet: { address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
			SupportedPaymentSource: { payTo: source.payTo },
			Settlement: null,
		};
		const mockReconciliationAttempt = (attempt: any, lockedAttempt: any = attempt) => {
			mockX402PaymentAttemptFindUnique.mockResolvedValueOnce({
				id: attempt.id,
				evmWalletId: attempt.evmWalletId,
			});
			mockTxX402PaymentAttemptFindUnique.mockResolvedValueOnce(lockedAttempt);
		};
		it('marks an ambiguous attempt Failed when the operator confirms funds did not move', async () => {
			mockReconciliationAttempt(backlogAttempt);

			const result = await service.reconcileX402PaymentAttempt({ attemptId: 'attempt-stuck', resolution: 'failed' });

			expect(result).toMatchObject({ attemptId: 'attempt-stuck', status: 'Failed' });
			const [walletLockQuery] = mockQueryRaw.mock.calls[0] as [readonly string[]];
			const [attemptLockQuery] = mockQueryRaw.mock.calls[1] as [readonly string[]];
			const [databaseClockQuery] = mockQueryRaw.mock.calls[2] as [readonly string[]];
			expect(walletLockQuery.join('')).toContain('"X402EvmWallet"');
			expect(attemptLockQuery.join('')).toContain('"X402PaymentAttempt"');
			expect(databaseClockQuery.join('')).toContain('clock_timestamp()');
			expect(mockQueryRaw.mock.invocationCallOrder[0]).toBeLessThan(mockQueryRaw.mock.invocationCallOrder[1]);
			expect(mockQueryRaw.mock.invocationCallOrder[1]).toBeLessThan(mockQueryRaw.mock.invocationCallOrder[2]);
			// Guarded on the status still being Verified so a concurrent resolution loses cleanly.
			expect(mockX402PaymentAttemptUpdateMany).toHaveBeenCalledWith(
				expect.objectContaining({
					where: { id: 'attempt-stuck', status: 'Verified' },
					data: { status: 'Failed' },
				}),
			);
			// The failure webhook carries the reason the settle recorded before it got stuck.
			expect(result.webhook).toMatchObject({
				success: false,
				errorReason: 'settle_threw',
				errorMessage: 'rpc getCode failed',
			});
			expect(mockX402SettlementCreate).not.toHaveBeenCalled();
		});

		it('409s a failed-resolution that lost the race to a concurrent resolution', async () => {
			mockReconciliationAttempt(backlogAttempt);
			// The eligibility read saw Verified, but by the time the guarded update runs another
			// reconcile (or a late settle) already resolved the attempt.
			mockX402PaymentAttemptUpdateMany.mockResolvedValueOnce({ count: 0 });

			await expect(
				service.reconcileX402PaymentAttempt({ attemptId: 'attempt-stuck', resolution: 'failed' }),
			).rejects.toMatchObject({ status: 409 });
		});

		it('records the settlement and marks the attempt Settled when funds moved', async () => {
			mockReconciliationAttempt(backlogAttempt);
			mockX402SettlementCreate.mockResolvedValueOnce({
				paymentAttemptId: 'attempt-stuck',
				paymentPayloadHash: 'hash-1',
				txHash: '0xpersisted',
			});

			const result = await service.reconcileX402PaymentAttempt({
				attemptId: 'attempt-stuck',
				resolution: 'settled',
				txHash: '0xtx',
			});

			expect(result).toMatchObject({ attemptId: 'attempt-stuck', status: 'Settled' });
			expect(mockX402SettlementCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					// The reconciled settlement is as complete as a normally-persisted one: it
					// carries the attempt's amount, not a null.
					data: expect.objectContaining({
						paymentAttemptId: 'attempt-stuck',
						paymentPayloadHash: 'hash-1',
						success: true,
						txHash: '0xtx',
						amount: source.amount,
					}),
				}),
			);
			// Webhook truth comes from the row that won the unique insert, never the caller input.
			expect(result.webhook).toMatchObject({
				success: true,
				txHash: '0xpersisted',
				errorReason: null,
				errorMessage: null,
			});
		});

		it('409s when another reconcile or attempt owns the unique settlement claim', async () => {
			mockReconciliationAttempt(backlogAttempt);
			mockX402SettlementCreate.mockRejectedValueOnce(
				new MockPrismaClientKnownRequestError('Unique constraint failed on paymentPayloadHash', 'P2002'),
			);

			await expect(
				service.reconcileX402PaymentAttempt({
					attemptId: 'attempt-stuck',
					resolution: 'settled',
					txHash: '0xloser',
				}),
			).rejects.toMatchObject({ status: 409 });
		});

		it('409s adapter-pg 23505 settlement claim conflicts', async () => {
			mockReconciliationAttempt(backlogAttempt);
			const error = new Error('duplicate key value violates unique constraint') as Error & {
				name: string;
				cause?: { code: string };
			};
			error.name = 'DriverAdapterError';
			error.cause = { code: '23505' };
			mockX402SettlementCreate.mockRejectedValueOnce(error);

			await expect(
				service.reconcileX402PaymentAttempt({
					attemptId: 'attempt-stuck',
					resolution: 'settled',
					txHash: '0xloser',
				}),
			).rejects.toMatchObject({ status: 409 });
		});

		it('409s a settled-resolution that lost the race to a concurrent resolution', async () => {
			mockReconciliationAttempt(backlogAttempt);
			mockX402PaymentAttemptUpdateMany.mockResolvedValueOnce({ count: 0 });

			await expect(
				service.reconcileX402PaymentAttempt({ attemptId: 'attempt-stuck', resolution: 'settled', txHash: '0xtx' }),
			).rejects.toMatchObject({ status: 409 });
			// The guard aborts the transaction before the settlement row is written.
			expect(mockX402SettlementCreate).not.toHaveBeenCalled();
		});

		it('requires a txHash to reconcile as settled', async () => {
			mockReconciliationAttempt(backlogAttempt);
			await expect(
				service.reconcileX402PaymentAttempt({ attemptId: 'attempt-stuck', resolution: 'settled' }),
			).rejects.toMatchObject({ status: 400 });
			expect(mockX402SettlementCreate).not.toHaveBeenCalled();
		});

		it('refuses to reconcile an attempt that is not awaiting reconciliation', async () => {
			// Already Settled WITH its settlement row → fully resolved, not in the backlog.
			mockReconciliationAttempt({
				...backlogAttempt,
				status: 'Settled',
				errorReason: null,
				Settlement: { id: 'settlement-1' },
			});
			await expect(
				service.reconcileX402PaymentAttempt({ attemptId: 'attempt-stuck', resolution: 'failed' }),
			).rejects.toMatchObject({ status: 409 });
			expect(mockX402PaymentAttemptUpdateMany).not.toHaveBeenCalled();
		});

		it('reconciles an interrupted settle that left no error trace once it is stale', async () => {
			// Process died mid-settle (or recording the outcome failed): Verified, NO errorReason.
			// Reconcilable purely by age — the marker outlived every legitimate settle.
			mockReconciliationAttempt({
				...backlogAttempt,
				errorReason: null,
				updatedAt: staleUpdatedAt,
			});

			const result = await service.reconcileX402PaymentAttempt({ attemptId: 'attempt-stuck', resolution: 'failed' });

			expect(result).toMatchObject({ attemptId: 'attempt-stuck', status: 'Failed' });
		});

		it('refuses to reconcile a trace-less Verified marker that may still be an in-flight settle', async () => {
			// Fresh + no errorReason: the settle may be live right now; declaring an outcome here
			// could race the real one, so age must gate it.
			mockReconciliationAttempt({
				...backlogAttempt,
				errorReason: null,
				updatedAt: databaseClockNow,
			});
			await expect(
				service.reconcileX402PaymentAttempt({ attemptId: 'attempt-stuck', resolution: 'failed' }),
			).rejects.toMatchObject({ status: 409 });
			expect(mockX402PaymentAttemptUpdateMany).not.toHaveBeenCalled();
		});

		it('refuses to reconcile while the self-hosted facilitator lock is fresh', async () => {
			// Discovery saw a stale marker, then the active settle renewed before reconciliation
			// obtained both row locks. Eligibility must come from the locked re-read.
			mockReconciliationAttempt(backlogAttempt, {
				...backlogAttempt,
				updatedAt: databaseClockNow,
				EvmWallet: { lockedAt: databaseClockNow },
			});

			await expect(
				service.reconcileX402PaymentAttempt({ attemptId: 'attempt-stuck', resolution: 'failed' }),
			).rejects.toMatchObject({ status: 409 });
			expect(mockX402PaymentAttemptUpdateMany).not.toHaveBeenCalled();
		});

		it('records the lost settlement row for a stale Settled attempt missing one', async () => {
			// Settle succeeded but persisting the settlement failed: buyer replays 409 until the
			// row exists. Reconciling as settled recreates it (status update is a no-op).
			mockReconciliationAttempt({
				...backlogAttempt,
				status: 'Settled',
				errorReason: null,
				updatedAt: staleUpdatedAt,
			});

			const result = await service.reconcileX402PaymentAttempt({
				attemptId: 'attempt-stuck',
				resolution: 'settled',
				txHash: '0xtx',
			});

			expect(result).toMatchObject({ attemptId: 'attempt-stuck', status: 'Settled' });
			expect(mockX402SettlementCreate).toHaveBeenCalledWith(
				expect.objectContaining({
					data: expect.objectContaining({
						paymentAttemptId: 'attempt-stuck',
						paymentPayloadHash: 'hash-1',
						success: true,
						txHash: '0xtx',
					}),
				}),
			);
		});

		it('refuses to mark a stale settlement-less Settled attempt as failed', async () => {
			// The facilitator already reported success — funds moved and the nonce is consumed, so
			// Failed (which would invite a retry) can never be the right resolution here.
			mockReconciliationAttempt({
				...backlogAttempt,
				status: 'Settled',
				errorReason: null,
				updatedAt: staleUpdatedAt,
			});
			await expect(
				service.reconcileX402PaymentAttempt({ attemptId: 'attempt-stuck', resolution: 'failed' }),
			).rejects.toMatchObject({ status: 409 });
			expect(mockX402PaymentAttemptUpdateMany).not.toHaveBeenCalled();
		});
	});

	describe('settle concurrency lock', () => {
		it('refuses a network config changed after the second resolver snapshot', async () => {
			// Both resolver reads see the same old snapshot, but the transaction-level CAS sees an
			// admin update that committed immediately afterward. No marker or chain call may start.
			mockTxX402NetworkFindUnique.mockResolvedValueOnce({
				isEnabled: true,
				updatedAt: new Date(networkUpdatedAt.getTime() + 1_000),
				rpcUrl: 'https://sepolia.base.org',
				facilitatorWalletId: 'wallet-facilitator',
				facilitatorUrl: null,
				facilitatorAuthEnc: null,
			});

			await expect(
				service.settleX402Payment({
					apiKeyId: 'api-key-1',
					caip2NetworkLimit: [source.network],
					supportedPaymentSourceId: source.id,
					paymentPayload: typedPaymentPayload,
				}),
			).rejects.toMatchObject({ status: 409 });

			expect(mockX402NetworkFindUnique).toHaveBeenCalledTimes(2);
			expect(mockX402PaymentAttemptCreate).not.toHaveBeenCalled();
			expect(mockFacilitatorSettle).not.toHaveBeenCalled();
		});

		it('re-resolves after locking and refuses a rotated facilitator wallet', async () => {
			const initialNetwork = {
				id: 'network-1',
				caip2Id: source.network,
				displayName: 'Base Sepolia',
				rpcUrl: 'https://sepolia.base.org',
				isEnabled: true,
				updatedAt: networkUpdatedAt,
				facilitatorWalletId: 'wallet-facilitator',
				facilitatorUrl: null,
				facilitatorAuthEnc: null,
				FacilitatorWallet: {
					id: 'wallet-facilitator',
					type: 'Selling',
					deletedAt: null,
					Secret: { encryptedPrivateKey: 'encrypted-private-key' },
				},
			};
			mockX402NetworkFindUnique.mockResolvedValueOnce(initialNetwork).mockResolvedValueOnce({
				...initialNetwork,
				facilitatorWalletId: 'wallet-replacement',
				FacilitatorWallet: {
					...initialNetwork.FacilitatorWallet,
					id: 'wallet-replacement',
				},
			});

			await expect(
				service.settleX402Payment({
					apiKeyId: 'api-key-1',
					caip2NetworkLimit: [source.network],
					supportedPaymentSourceId: source.id,
					paymentPayload: typedPaymentPayload,
				}),
			).rejects.toMatchObject({ status: 409 });

			expect(mockX402NetworkFindUnique).toHaveBeenCalledTimes(2);
			expect(mockX402PaymentAttemptCreate).not.toHaveBeenCalled();
			expect(mockFacilitatorSettle).not.toHaveBeenCalled();
		});

		it('re-resolves after locking and refuses a network disabled while queued', async () => {
			const initialNetwork = {
				id: 'network-1',
				caip2Id: source.network,
				displayName: 'Base Sepolia',
				rpcUrl: 'https://sepolia.base.org',
				isEnabled: true,
				updatedAt: networkUpdatedAt,
				facilitatorWalletId: 'wallet-facilitator',
				facilitatorUrl: null,
				facilitatorAuthEnc: null,
				FacilitatorWallet: {
					id: 'wallet-facilitator',
					type: 'Selling',
					deletedAt: null,
					Secret: { encryptedPrivateKey: 'encrypted-private-key' },
				},
			};
			mockX402NetworkFindUnique
				.mockResolvedValueOnce(initialNetwork)
				.mockResolvedValueOnce({ ...initialNetwork, isEnabled: false });

			await expect(
				service.settleX402Payment({
					apiKeyId: 'api-key-1',
					caip2NetworkLimit: [source.network],
					supportedPaymentSourceId: source.id,
					paymentPayload: typedPaymentPayload,
				}),
			).rejects.toMatchObject({ status: 404 });

			expect(mockX402PaymentAttemptCreate).not.toHaveBeenCalled();
			expect(mockFacilitatorSettle).not.toHaveBeenCalled();
		});

		it('takes and releases the per-facilitator DB settle lock around the on-chain settle', async () => {
			await service.settleX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: [source.network],
				supportedPaymentSourceId: source.id,
				paymentPayload: typedPaymentPayload,
			});

			// Acquire: the stale check and clock token are one PostgreSQL UPDATE, so application pauses
			// cannot turn a freshly written lease into an already-stale one.
			const acquireCall = (mockQueryRaw.mock.calls as Array<[readonly string[], ...unknown[]]>).find(
				([parts]) => parts.join('').includes('UPDATE "X402EvmWallet"') && parts.join('').includes('"lockedAt" IS NULL'),
			);
			expect(acquireCall?.[0].join('')).toContain('SET "lockedAt" = clock_timestamp()');
			expect(acquireCall?.[0].join('')).toContain('RETURNING "lockedAt"');
			expect(acquireCall?.[1]).toBe('wallet-facilitator');
			// Release: clear it, guarded on the token still being ours (compare-and-release).
			expect(mockX402EvmWalletUpdateMany).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({ id: 'wallet-facilitator', lockedAt: expect.any(Date) }),
					data: { lockedAt: null },
				}),
			);
			expect(mockFacilitatorSettle).toHaveBeenCalledTimes(1);
		});

		it('claims the exact payload before checking and creating the durable settle marker', async () => {
			await service.settleX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: [source.network],
				supportedPaymentSourceId: source.id,
				paymentPayload: typedPaymentPayload,
			});

			const rawCalls = mockQueryRaw.mock.calls as Array<[readonly string[], ...unknown[]]>;
			const advisoryCallIndex = rawCalls.findIndex(([queryParts]) =>
				queryParts.join('').includes('pg_advisory_xact_lock(hashtextextended('),
			);
			const networkLockCallIndex = rawCalls.findIndex(([queryParts]) =>
				queryParts.join('').includes('FROM "X402Network"'),
			);
			expect(advisoryCallIndex).toBeGreaterThanOrEqual(0);
			expect(networkLockCallIndex).toBeGreaterThanOrEqual(0);
			const [queryParts, lockedPayloadHash] = rawCalls[advisoryCallIndex] as [readonly string[], string];
			expect(queryParts.join('')).toContain('pg_advisory_xact_lock(hashtextextended(');
			expect(lockedPayloadHash).toBe(service.hashX402PaymentPayload(paymentPayload));
			const [networkLockQuery, lockedNetworkId] = rawCalls[networkLockCallIndex] as [readonly string[], string];
			expect(networkLockQuery.join('')).toContain('FROM "X402Network"');
			expect(networkLockQuery.join('')).toContain('FOR SHARE');
			expect(lockedNetworkId).toBe('network-1');
			expect(rawCalls.filter(([parts]) => parts.join('').includes('clock_timestamp()'))).toHaveLength(3);
			expect(mockQueryRaw.mock.invocationCallOrder[advisoryCallIndex]).toBeLessThan(
				mockX402PaymentAttemptFindFirst.mock.invocationCallOrder[0],
			);
			expect(mockX402PaymentAttemptFindFirst.mock.invocationCallOrder[0]).toBeLessThan(
				mockX402PaymentAttemptCreate.mock.invocationCallOrder[0],
			);
		});

		it('rejects a racing same-payload settle via the crash-window guard without leaving a stuck marker', async () => {
			// A prior in-flight/settled attempt exists for this payload. The guard runs INSIDE the
			// lock and BEFORE the pre-settle marker, so the racing settle must 409 without creating a
			// marker and without recording settle_threw — the same "no marker → clean" path a lock
			// acquisition timeout takes, so the payload stays cleanly retryable.
			mockX402PaymentAttemptFindFirst.mockResolvedValueOnce({ id: 'prior-attempt' });

			await expect(
				service.settleX402Payment({
					apiKeyId: 'api-key-1',
					caip2NetworkLimit: [source.network],
					supportedPaymentSourceId: source.id,
					paymentPayload: typedPaymentPayload,
				}),
			).rejects.toMatchObject({ status: 409 });

			expect(mockX402PaymentAttemptCreate).not.toHaveBeenCalled();
			expect(mockFacilitatorSettle).not.toHaveBeenCalled();
			expect(mockX402PaymentAttemptUpdateMany).not.toHaveBeenCalledWith(
				expect.objectContaining({ data: expect.objectContaining({ errorReason: 'settle_threw' }) }),
			);
		});

		it('skips the wallet nonce lock for a remote facilitator but still claims the payment payload', async () => {
			mockX402NetworkFindUnique.mockResolvedValue({
				id: 'network-1',
				caip2Id: source.network,
				displayName: 'Base Sepolia',
				rpcUrl: 'https://sepolia.base.org',
				isEnabled: true,
				updatedAt: networkUpdatedAt,
				facilitatorWalletId: null,
				facilitatorUrl: 'https://facilitator.example',
				facilitatorAuthEnc: null,
				FacilitatorWallet: null,
			});
			mockTxX402NetworkFindUnique.mockResolvedValue({
				isEnabled: true,
				updatedAt: networkUpdatedAt,
				rpcUrl: 'https://sepolia.base.org',
				facilitatorWalletId: null,
				facilitatorUrl: 'https://facilitator.example',
				facilitatorAuthEnc: null,
			});

			await service.settleX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: [source.network],
				supportedPaymentSourceId: source.id,
				paymentPayload: typedPaymentPayload,
			});

			expect(mockFacilitatorSettle).toHaveBeenCalledTimes(1);
			expect(mockX402EvmWalletUpdateMany).not.toHaveBeenCalled();
			const rawCalls = mockQueryRaw.mock.calls as Array<[readonly string[], ...unknown[]]>;
			const advisoryCall = rawCalls.find(([parts]) => parts.join('').includes('pg_advisory_xact_lock'));
			const networkLockCall = rawCalls.find(([parts]) => parts.join('').includes('FROM "X402Network"'));
			expect(advisoryCall?.[1]).toBe(service.hashX402PaymentPayload(paymentPayload));
			const [networkLockQuery, lockedNetworkId] = networkLockCall as [readonly string[], string];
			expect(networkLockQuery.join('')).toContain('FROM "X402Network"');
			expect(networkLockQuery.join('')).toContain('FOR SHARE');
			expect(lockedNetworkId).toBe('network-1');
			expect(rawCalls.filter(([parts]) => parts.join('').includes('clock_timestamp()'))).toHaveLength(1);
		});
	});
});
