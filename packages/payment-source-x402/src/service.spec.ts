import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockSupportedPaymentSourceFindUnique = jest.fn() as jest.Mock<any>;
const mockX402NetworkFindUnique = jest.fn() as jest.Mock<any>;
const mockX402SettlementFindUnique = jest.fn() as jest.Mock<any>;
const mockX402SettlementUpsert = jest.fn() as jest.Mock<any>;
const mockX402PaymentAttemptCreate = jest.fn() as jest.Mock<any>;
const mockX402PaymentAttemptUpdate = jest.fn() as jest.Mock<any>;
const mockX402EvmWalletFindUnique = jest.fn() as jest.Mock<any>;
const mockApiKeyFindUnique = jest.fn() as jest.Mock<any>;
const mockX402EvmWalletCreate = jest.fn() as jest.Mock<any>;
const mockBudgetFindFirst = jest.fn() as jest.Mock<any>;

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
	Prisma: { PrismaClientKnownRequestError: MockPrismaClientKnownRequestError },
	X402EvmWalletType: {
		Purchasing: 'Purchasing',
		Selling: 'Selling',
	},
	X402PaymentDirection: {
		InboundVerify: 'InboundVerify',
		InboundSettle: 'InboundSettle',
		OutboundPayment: 'OutboundPayment',
	},
	X402PaymentScheme: {
		Exact: 'Exact',
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
		},
		apiKey: {
			findUnique: mockApiKeyFindUnique,
		},
		x402Settlement: {
			findUnique: mockX402SettlementFindUnique,
			upsert: mockX402SettlementUpsert,
		},
		x402PaymentAttempt: {
			create: mockX402PaymentAttemptCreate,
			update: mockX402PaymentAttemptUpdate,
		},
		x402EvmWallet: {
			findUnique: mockX402EvmWalletFindUnique,
			create: mockX402EvmWalletCreate,
			findMany: jest.fn(),
		},
		x402WalletBudget: {
			findFirst: mockBudgetFindFirst,
			update: mockBudgetUpdate,
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

jest.unstable_mockModule('@x402/core/http', () => ({
	encodePaymentSignatureHeader: mockEncodePaymentSignatureHeader,
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

const source = {
	id: 'source-1',
	registryRequestId: 'registry-1',
	chain: 'EVM',
	network: 'eip155:84532',
	scheme: 'Exact',
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
	},
};

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
		latestClient = null;
		mockSupportedPaymentSourceFindUnique.mockResolvedValue(source);
		mockX402NetworkFindUnique.mockResolvedValue({
			id: 'network-1',
			caip2Id: source.network,
			displayName: 'Base Sepolia',
			rpcUrl: 'https://sepolia.base.org',
			isEnabled: true,
			FacilitatorWallet: {
				id: 'wallet-facilitator',
				type: 'Selling',
				encryptedPrivateKey: 'encrypted-private-key',
			},
		});
		mockX402EvmWalletFindUnique.mockResolvedValue({
			id: 'wallet-1',
			address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			type: 'Purchasing',
			encryptedPrivateKey: 'encrypted-private-key',
			deletedAt: null,
		});
		mockApiKeyFindUnique.mockResolvedValue({ id: 'api-key-1' });
		mockX402EvmWalletCreate.mockResolvedValue({
			id: 'wallet-new',
			address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
			type: 'Purchasing',
			createdAt: new Date('2026-01-01T00:00:00.000Z'),
			updatedAt: new Date('2026-01-01T00:00:00.000Z'),
			createdById: 'api-key-1',
		});
		mockX402SettlementFindUnique.mockResolvedValue(null);
		mockX402SettlementUpsert.mockResolvedValue({ id: 'settlement-1' });
		mockX402PaymentAttemptCreate.mockResolvedValue({ id: 'attempt-1' });
		mockX402PaymentAttemptUpdate.mockResolvedValue({ id: 'attempt-1' });
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
		mockBudgetFindFirst.mockResolvedValue({ id: 'budget-1' });
		mockBudgetUpdateMany.mockResolvedValue({ count: 1 });
		mockBudgetUpdate.mockResolvedValue({ id: 'budget-1' });
		mockBudgetUpsert.mockResolvedValue({
			id: 'budget-1',
			apiKeyId: 'api-key-1',
			evmWalletId: 'wallet-1',
			caip2Network: source.network,
			asset: source.asset.toLowerCase(),
			remainingAmount: 100n,
			spentAmount: 0n,
			createdAt: new Date('2026-01-01T00:00:00.000Z'),
			updatedAt: new Date('2026-01-01T00:00:00.000Z'),
		});
		mockTxPaymentAttemptCreate.mockResolvedValue({ id: 'attempt-outbound-1' });
		mockPrismaTransaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
			callback({
				x402WalletBudget: {
					findFirst: mockBudgetFindFirst,
					updateMany: mockBudgetUpdateMany,
				},
				x402PaymentAttempt: {
					create: mockTxPaymentAttemptCreate,
				},
			}),
		);
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

	it('deduplicates settle replays by canonical payment payload hash bound to the same source', async () => {
		const paymentPayloadHash = service.hashX402PaymentPayload(paymentPayload);
		mockX402SettlementFindUnique.mockResolvedValue({
			id: 'settlement-1',
			paymentPayloadHash,
			txHash: '0xsettled',
			caip2Network: source.network,
			amount: source.amount,
			payer: null,
			PaymentAttempt: {
				id: 'attempt-original',
				payer: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				supportedPaymentSourceId: source.id,
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
				}),
			}),
		);
	});

	it('rejects a settle replay whose prior settlement belongs to a different source', async () => {
		const paymentPayloadHash = service.hashX402PaymentPayload(paymentPayload);
		mockX402SettlementFindUnique.mockResolvedValue({
			id: 'settlement-1',
			paymentPayloadHash,
			txHash: '0xsettled',
			caip2Network: source.network,
			amount: source.amount,
			payer: null,
			PaymentAttempt: {
				id: 'attempt-original',
				payer: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				supportedPaymentSourceId: 'a-different-source',
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
					apiKeyId_evmWalletId_caip2Network_asset: {
						apiKeyId: 'api-key-1',
						evmWalletId: 'wallet-1',
						caip2Network: source.network,
						asset: source.asset.toLowerCase(),
					},
				},
				create: expect.objectContaining({
					asset: source.asset.toLowerCase(),
				}),
			}),
		);
	});

	it('rejects setting a budget for an unregistered network with a 404', async () => {
		mockX402NetworkFindUnique.mockResolvedValueOnce(null);
		await expect(
			service.setX402WalletBudget({
				apiKeyId: 'api-key-1',
				evmWalletId: 'wallet-1',
				caip2Network: source.network,
				asset: source.asset,
				remainingAmount: '100',
			}),
		).rejects.toMatchObject({ status: 404 });
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
				type: 'Purchasing' as Parameters<typeof service.createX402ManagedWallet>[0]['type'],
				privateKey: `0x${'a'.repeat(64)}`,
			}),
		).rejects.toMatchObject({ status: 409 });
	});

	it('returns the generated private key once when no key is supplied', async () => {
		const result = await service.createX402ManagedWallet({
			createdByApiKeyId: 'api-key-1',
			type: 'Purchasing' as Parameters<typeof service.createX402ManagedWallet>[0]['type'],
		});
		// generatePrivateKey is mocked to a fixed 0xbb… key; it must be surfaced for backup.
		expect(result.privateKey).toBe(`0x${'b'.repeat(64)}`);
	});

	it('does not echo back a caller-supplied private key', async () => {
		const result = await service.createX402ManagedWallet({
			createdByApiKeyId: 'api-key-1',
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
					where: expect.objectContaining({ id: 'budget-1', remainingAmount: { gte: source.amount } }),
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

		it('rejects when no managed wallet budget covers the requirement', async () => {
			mockBudgetFindFirst.mockResolvedValue(null);

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
			mockX402EvmWalletFindUnique.mockResolvedValueOnce({
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

		it.each([['-1000'], ['0'], ['1.5'], ['abc'], ['']])(
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

		it('allows an admin (null network limit) to sign for any enabled network', async () => {
			const result = await service.createX402Payment({
				apiKeyId: 'api-key-1',
				caip2NetworkLimit: null,
				evmWalletId: 'wallet-1',
				paymentRequired,
			});

			expect(result.xPaymentHeader).toBe('x-payment-header-base64');
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
			expect(mockBudgetUpdate).toHaveBeenCalledWith({
				where: { id: 'budget-1' },
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
			expect(mockBudgetUpdate).toHaveBeenCalledWith({
				where: { id: 'budget-1' },
				data: {
					remainingAmount: { increment: source.amount },
					spentAmount: { decrement: source.amount },
				},
			});
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
				}),
			);
		});
	});
});
