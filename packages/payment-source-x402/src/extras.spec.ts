import { describe, expect, it, jest } from '@jest/globals';

const mockPaymentAttemptFindMany = jest.fn() as jest.Mock<any>;

// Mock the heavy module surface so the pure/aggregation logic can be exercised without a
// real database, RPC, or logger.
jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	Prisma: {},
	LowBalanceStatus: { Unknown: 'Unknown', Healthy: 'Healthy', Low: 'Low' },
	X402PaymentDirection: {
		InboundVerify: 'InboundVerify',
		InboundSettle: 'InboundSettle',
		OutboundPayment: 'OutboundPayment',
	},
	X402PaymentStatus: {
		PaymentRequired: 'PaymentRequired',
		Verified: 'Verified',
		Settled: 'Settled',
		Failed: 'Failed',
		Replayed: 'Replayed',
	},
	X402EvmWalletType: { Purchasing: 'Purchasing', Selling: 'Selling' },
	prisma: {
		x402PaymentAttempt: { findMany: mockPaymentAttemptFindMany },
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.unstable_mockModule('@masumi/payment-core/encryption', () => ({
	decrypt: jest.fn(),
	encrypt: jest.fn(),
}));

jest.unstable_mockModule('viem', () => ({
	createPublicClient: jest.fn(),
	defineChain: jest.fn((chain: unknown) => chain),
	http: jest.fn((url: string) => ({ url })),
}));

jest.unstable_mockModule('viem/accounts', () => ({
	generatePrivateKey: jest.fn(),
	privateKeyToAccount: jest.fn(),
}));

const { computeLowBalanceStatus } = await import('./low-balance');
const { getX402Analytics } = await import('./analytics');

describe('computeLowBalanceStatus', () => {
	it('is Low strictly below the threshold and Healthy at or above it', () => {
		expect(computeLowBalanceStatus(9n, 10n)).toBe('Low');
		expect(computeLowBalanceStatus(10n, 10n)).toBe('Healthy');
		expect(computeLowBalanceStatus(11n, 10n)).toBe('Healthy');
		expect(computeLowBalanceStatus(0n, 1n)).toBe('Low');
	});
});

describe('getX402Analytics', () => {
	it('splits inbound settled (income) from outbound (spend) and sums by network/asset', async () => {
		const day = new Date('2026-06-01T10:00:00.000Z');
		mockPaymentAttemptFindMany.mockResolvedValue([
			{
				createdAt: day,
				direction: 'InboundSettle',
				Network: { caip2Id: 'eip155:8453' },
				asset: '0xusdc',
				amount: 1000n,
			},
			{
				createdAt: day,
				direction: 'InboundSettle',
				Network: { caip2Id: 'eip155:8453' },
				asset: '0xusdc',
				amount: 500n,
			},
			{
				createdAt: day,
				direction: 'OutboundPayment',
				Network: { caip2Id: 'eip155:8453' },
				asset: '0xusdc',
				amount: 200n,
			},
		]);

		const result = await getX402Analytics({ timeZone: 'Etc/UTC' });

		expect(result.incomeCount).toBe(2);
		expect(result.spendCount).toBe(1);
		expect(result.TotalIncome).toEqual([{ caip2Network: 'eip155:8453', asset: '0xusdc', amount: '1500' }]);
		expect(result.TotalSpend).toEqual([{ caip2Network: 'eip155:8453', asset: '0xusdc', amount: '200' }]);
		expect(result.Daily).toHaveLength(1);
		expect(result.Daily[0]).toMatchObject({ year: 2026, month: 6, day: 1 });
	});

	it('falls back to Etc/UTC for an invalid timezone', async () => {
		mockPaymentAttemptFindMany.mockResolvedValue([]);
		const result = await getX402Analytics({ timeZone: 'Not/AZone' });
		expect(result.TotalIncome).toEqual([]);
		expect(result.TotalSpend).toEqual([]);
	});
});
