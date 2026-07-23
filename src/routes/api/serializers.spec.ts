import { jest } from '@jest/globals';

jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONFIG: {
		LOW_BALANCE_DEFAULT_RULES_MAINNET: [],
		LOW_BALANCE_DEFAULT_RULES_PREPROD: [],
	},
	CONSTANTS: {
		MIN_TX_FEE_BUFFER_LOVELACE: 2000000n,
	},
	SERVICE_CONSTANTS: {
		RETRY: { maxRetries: 5, backoffMultiplier: 5, initialDelayMs: 500, maxDelayMs: 7500 },
		TRANSACTION: { timeBufferMs: 150000, blockTimeBufferMs: 60000, validitySlotBuffer: 5, resultTimeSlotBuffer: 3 },
		SMART_CONTRACT: {
			collateralAmount: '5000000',
			mintQuantity: '1',
			defaultExUnits: { mem: 7000000, steps: 3000000000 },
		},
		METADATA: { nftLabel: 721, masumiLabel: 674 },
		CARDANO: { NATIVE_TOKEN: 'lovelace' },
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

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {},
}));

let PricingType: typeof import('@/generated/prisma/client').PricingType;
let TransactionLayer: typeof import('@/generated/prisma/client').TransactionLayer;
let TransactionStatus: typeof import('@/generated/prisma/client').TransactionStatus;
let generateBlockchainIdentifier: typeof import('@masumi/payment-core/blockchain-identifier').generateBlockchainIdentifier;
let serializePaymentSourceEntry: typeof import('./payment-source/serializers').serializePaymentSourceEntry;
let serializePaymentListEntry: typeof import('./payments/serializers').serializePaymentListEntry;
let serializePurchasesResponse: typeof import('./purchases/serializers').serializePurchasesResponse;
let serializeRegistryEntry: typeof import('./registry/serializers').serializeRegistryEntry;
let serializeInboxRegistryEntry: typeof import('./registry-inbox/serializers').serializeInboxRegistryEntry;
let serializeSwapTransaction: typeof import('./swap/serializers').serializeSwapTransaction;

describe('route serializers', () => {
	beforeAll(async () => {
		({ PricingType, TransactionLayer, TransactionStatus } = await import('@/generated/prisma/client'));
		({ generateBlockchainIdentifier } = await import('@masumi/payment-core/blockchain-identifier'));
		({ serializePaymentSourceEntry } = await import('./payment-source/serializers'));
		({ serializePaymentListEntry } = await import('./payments/serializers'));
		({ serializePurchasesResponse } = await import('./purchases/serializers'));
		({ serializeRegistryEntry } = await import('./registry/serializers'));
		({ serializeInboxRegistryEntry } = await import('./registry-inbox/serializers'));
		({ serializeSwapTransaction } = await import('./swap/serializers'));
	});

	it('serializes payment list entries without changing response shape', () => {
		const blockchainIdentifier = generateBlockchainIdentifier(
			'reference-key',
			'signature',
			`${'a'.repeat(64)}abcdef`,
			'c'.repeat(64),
		);
		const payment = {
			id: 'payment-1',
			blockchainIdentifier,
			submitResultTime: BigInt(10),
			payByTime: BigInt(20),
			unlockTime: BigInt(30),
			externalDisputeUnlockTime: BigInt(40),
			collateralReturnLovelace: BigInt(50),
			sellerCoolDownTime: BigInt(60),
			buyerCoolDownTime: BigInt(70),
			totalBuyerCardanoFees: BigInt(2_500_000),
			totalSellerCardanoFees: BigInt(1_500_000),
			RequestedFunds: [{ id: 'fund-1', unit: 'lovelace', amount: BigInt(1_000_000) }],
			WithdrawnForSeller: [{ id: 'seller-1', unit: 'lovelace', amount: BigInt(500_000) }],
			WithdrawnForBuyer: [{ id: 'buyer-1', unit: 'lovelace', amount: BigInt(250_000) }],
			CurrentTransaction: {
				id: 'tx-1',
				createdAt: new Date('2026-01-01T00:00:00.000Z'),
				updatedAt: new Date('2026-01-01T00:00:00.000Z'),
				fees: BigInt(123456),
				blockHeight: 1,
				blockTime: new Date('2026-01-01T00:00:00.000Z'),
				txHash: 'hash-1',
				status: TransactionStatus.Pending,
				previousOnChainState: null,
				newOnChainState: null,
				confirmations: 1,
			},
			TransactionHistory: [
				{
					id: 'history-1',
					createdAt: new Date('2026-01-01T00:00:00.000Z'),
					updatedAt: new Date('2026-01-01T00:00:00.000Z'),
					txHash: 'hash-1',
					status: TransactionStatus.Pending,
					fees: BigInt(654321),
					blockHeight: 1,
					blockTime: new Date('2026-01-01T00:00:00.000Z'),
					previousOnChainState: null,
					newOnChainState: null,
					confirmations: 1,
				},
			],
			ActionHistory: [],
			forceLayer: TransactionLayer.L2,
		} as unknown as Parameters<typeof serializePaymentListEntry>[0];

		const serialized = serializePaymentListEntry(payment);

		expect(serialized.agentIdentifier).toBe('abcdef');
		expect(serialized.submitResultTime).toBe('10');
		expect(serialized.RequestedFunds[0].amount).toBe('1000000');
		expect(serialized.CurrentTransaction?.fees).toBe('123456');
		expect(serialized.TransactionHistory?.[0]?.fees).toBe('654321');
		expect(serialized.totalBuyerCardanoFees).toBe(2.5);
		expect(serialized.totalSellerCardanoFees).toBe(1.5);
		expect(serialized.forceLayer).toBe('Hydra');
	});

	it('maps internal purchase layer overrides to the public API vocabulary', () => {
		const purchase = {
			id: 'purchase-1',
			blockchainIdentifier: 'identifier',
			agentIdentifier: 'agent',
			submitResultTime: 10n,
			payByTime: 20n,
			unlockTime: 30n,
			externalDisputeUnlockTime: 40n,
			collateralReturnLovelace: null,
			sellerCoolDownTime: 50n,
			buyerCoolDownTime: 60n,
			totalBuyerCardanoFees: 0n,
			totalSellerCardanoFees: 0n,
			PaidFunds: [],
			WithdrawnForSeller: [],
			WithdrawnForBuyer: [],
			CurrentTransaction: null,
			TransactionHistory: [],
			ActionHistory: [],
			forceLayer: TransactionLayer.L2,
			paymentForceLayer: TransactionLayer.L1,
		} as unknown as Parameters<typeof serializePurchasesResponse>[0][number];

		const serialized = serializePurchasesResponse([purchase]).Purchases[0]!;

		expect(serialized.forceLayer).toBe('Hydra');
		expect(serialized.paymentForceLayer).toBe('L1');
	});

	it('prefers persisted agentIdentifier over decoding blockchain identifier', () => {
		const blockchainIdentifier = generateBlockchainIdentifier(
			'reference-key',
			'signature',
			`${'a'.repeat(64)}abcdef`,
			'c'.repeat(64),
		);
		const payment = {
			id: 'payment-2',
			blockchainIdentifier,
			agentIdentifier: 'override-from-db',
			submitResultTime: BigInt(10),
			payByTime: BigInt(20),
			unlockTime: BigInt(30),
			externalDisputeUnlockTime: BigInt(40),
			collateralReturnLovelace: BigInt(50),
			sellerCoolDownTime: BigInt(60),
			buyerCoolDownTime: BigInt(70),
			totalBuyerCardanoFees: BigInt(2_500_000),
			totalSellerCardanoFees: BigInt(1_500_000),
			RequestedFunds: [{ id: 'fund-1', unit: 'lovelace', amount: BigInt(1_000_000) }],
			WithdrawnForSeller: [{ id: 'seller-1', unit: 'lovelace', amount: BigInt(500_000) }],
			WithdrawnForBuyer: [{ id: 'buyer-1', unit: 'lovelace', amount: BigInt(250_000) }],
			CurrentTransaction: null,
			TransactionHistory: [],
			ActionHistory: [],
		} as unknown as Parameters<typeof serializePaymentListEntry>[0];

		expect(serializePaymentListEntry(payment).agentIdentifier).toBe('override-from-db');
	});

	it('serializes registry pricing and transaction fees deterministically', () => {
		const entry = {
			capabilityName: 'demo',
			capabilityVersion: '1.0.0',
			authorName: 'Author',
			authorContactEmail: 'author@example.com',
			authorContactOther: null,
			authorOrganization: 'Masumi',
			privacyPolicy: 'privacy',
			terms: 'terms',
			other: null,
			tags: ['agent'],
			Pricing: {
				pricingType: PricingType.Fixed,
				FixedPricing: {
					Amounts: [{ unit: 'lovelace', amount: BigInt(1_000_000) }],
				},
			},
			sendFundingLovelace: BigInt(7_500_000),
			RecipientWallet: {
				walletVkey: 'recipient-vkey',
				walletAddress: 'recipient-address',
			},
			CurrentTransaction: {
				txHash: 'tx-1',
				status: TransactionStatus.Pending,
				confirmations: 2,
				fees: BigInt(777),
				blockHeight: 1,
				blockTime: new Date('2026-01-01T00:00:00.000Z'),
			},
			SupportedPaymentSources: [],
		} as unknown as Parameters<typeof serializeRegistryEntry>[0];

		const serialized = serializeRegistryEntry(entry);

		expect(serialized.Capability).toEqual({ name: 'demo', version: '1.0.0' });
		expect(serialized.AgentPricing).toEqual({
			pricingType: PricingType.Fixed,
			Pricing: [{ unit: 'lovelace', amount: '1000000' }],
		});
		expect(serialized.RecipientWallet).toEqual({
			walletVkey: 'recipient-vkey',
			walletAddress: 'recipient-address',
		});
		expect(serialized.sendFundingLovelace).toBe('7500000');
		expect(serialized.CurrentTransaction?.fees).toBe('777');
	});

	it('serializes inbox registry transaction fields deterministically', () => {
		const entry = {
			sendFundingLovelace: BigInt(7_500_000),
			CurrentTransaction: {
				txHash: 'tx-1',
				status: TransactionStatus.Pending,
				confirmations: 2,
				fees: BigInt(888),
				blockHeight: 1,
				blockTime: new Date('2026-01-01T00:00:00.000Z'),
			},
		} as unknown as Parameters<typeof serializeInboxRegistryEntry>[0];

		const serialized = serializeInboxRegistryEntry(entry);

		expect(serialized.sendFundingLovelace).toBe('7500000');
		expect(serialized.CurrentTransaction?.fees).toBe('888');
	});

	it('serializes a payment source entry without embedding hot wallets', () => {
		const paymentSource = {
			id: 'source-1',
			AdminWallets: [{ walletAddress: 'admin-address', order: 0 }],
			FeeReceiverNetworkWallet: { walletAddress: 'fee-address' },
		} as unknown as Parameters<typeof serializePaymentSourceEntry>[0];

		const serialized = serializePaymentSourceEntry(paymentSource);

		expect(serialized).toEqual(paymentSource);
		expect('SellingWallets' in serialized).toBe(false);
		expect('PurchasingWallets' in serialized).toBe(false);
	});

	it('serializes swap transactions with ISO timestamps intact', () => {
		const swapTransaction = {
			id: 'swap-1',
			createdAt: new Date('2026-01-01T00:00:00.000Z'),
			txHash: 'hash-1',
			status: 'Pending',
			swapStatus: 'OrderPending',
			confirmations: 3,
			fromPolicyId: 'from',
			fromAssetName: 'ADA',
			fromAmount: '1',
			toPolicyId: 'to',
			toAssetName: 'USDM',
			poolId: 'pool-1',
			slippage: 0.03,
			cancelTxHash: null,
			orderOutputIndex: 1,
		} as unknown as Parameters<typeof serializeSwapTransaction>[0];

		expect(serializeSwapTransaction(swapTransaction)).toEqual({
			id: 'swap-1',
			createdAt: '2026-01-01T00:00:00.000Z',
			txHash: 'hash-1',
			status: 'Pending',
			swapStatus: 'OrderPending',
			confirmations: 3,
			fromPolicyId: 'from',
			fromAssetName: 'ADA',
			fromAmount: '1',
			toPolicyId: 'to',
			toAssetName: 'USDM',
			poolId: 'pool-1',
			slippage: 0.03,
			cancelTxHash: null,
			orderOutputIndex: 1,
		});
	});
});
