import { jest } from '@jest/globals';

jest.unstable_mockModule('@/utils/config', () => ({
	CONFIG: {
		LOW_BALANCE_DEFAULT_RULES_MAINNET: [],
		LOW_BALANCE_DEFAULT_RULES_PREPROD: [],
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

jest.unstable_mockModule('@/utils/db', () => ({
	prisma: {},
}));

const { HotWalletType, PricingType, TransactionStatus } = await import('@/generated/prisma/client');
const { generateBlockchainIdentifier } = await import('@/utils/generator/blockchain-identifier-generator');
const { serializePaymentSourceEntry } = await import('./payment-source/serializers');
const { serializePaymentListEntry } = await import('./payments/serializers');
const { serializeRegistryEntry } = await import('./registry/serializers');
const { serializeSwapTransaction } = await import('./swap/serializers');

describe('route serializers', () => {
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
		} as unknown as Parameters<typeof serializePaymentListEntry>[0];

		const serialized = serializePaymentListEntry(payment);

		expect(serialized.agentIdentifier).toBe('abcdef');
		expect(serialized.submitResultTime).toBe('10');
		expect(serialized.RequestedFunds[0].amount).toBe('1000000');
		expect(serialized.CurrentTransaction?.fees).toBe('123456');
		expect(serialized.TransactionHistory?.[0]?.fees).toBe('654321');
		expect(serialized.totalBuyerCardanoFees).toBe(2.5);
		expect(serialized.totalSellerCardanoFees).toBe(1.5);
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
			CurrentTransaction: {
				txHash: 'tx-1',
				status: TransactionStatus.Pending,
				confirmations: 2,
				fees: BigInt(777),
				blockHeight: 1,
				blockTime: new Date('2026-01-01T00:00:00.000Z'),
			},
		} as unknown as Parameters<typeof serializeRegistryEntry>[0];

		const serialized = serializeRegistryEntry(entry);

		expect(serialized.Capability).toEqual({ name: 'demo', version: '1.0.0' });
		expect(serialized.AgentPricing).toEqual({
			pricingType: PricingType.Fixed,
			Pricing: [{ unit: 'lovelace', amount: '1000000' }],
		});
		expect(serialized.CurrentTransaction?.fees).toBe('777');
	});

	it('serializes payment sources by wallet type', () => {
		const paymentSource = {
			id: 'source-1',
			HotWallets: [
				{
					id: 'wallet-selling',
					type: HotWalletType.Selling,
					walletVkey: 'selling-vkey',
					walletAddress: 'selling-address',
					collectionAddress: null,
					note: 'selling',
					LowBalanceRules: [],
				},
				{
					id: 'wallet-purchasing',
					type: HotWalletType.Purchasing,
					walletVkey: 'purchasing-vkey',
					walletAddress: 'purchasing-address',
					collectionAddress: null,
					note: 'purchasing',
					LowBalanceRules: [],
				},
			],
		} as unknown as Parameters<typeof serializePaymentSourceEntry>[0];

		const serialized = serializePaymentSourceEntry(paymentSource);

		expect(serialized.SellingWallets).toHaveLength(1);
		expect(serialized.PurchasingWallets).toHaveLength(1);
		expect(serialized.SellingWallets[0]?.walletVkey).toBe('selling-vkey');
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
