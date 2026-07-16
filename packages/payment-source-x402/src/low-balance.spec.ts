import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRuleFindMany = jest.fn() as jest.Mock<any>;
const mockRuleUpdate = jest.fn() as jest.Mock<any>;
const mockNetworkFindMany = jest.fn() as jest.Mock<any>;
const mockReadAssetAmount = jest.fn() as jest.Mock<any>;
const mockLoggerWarn = jest.fn();

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	Prisma: {},
	LowBalanceStatus: { Unknown: 'Unknown', Healthy: 'Healthy', Low: 'Low' },
	X402EvmWalletType: { Purchasing: 'Purchasing', Selling: 'Selling' },
	prisma: {
		x402EvmWalletLowBalanceRule: {
			findMany: mockRuleFindMany,
			update: mockRuleUpdate,
		},
		x402Network: {
			findMany: mockNetworkFindMany,
		},
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: mockLoggerWarn, error: jest.fn() },
}));

jest.unstable_mockModule('./balance', () => ({
	NATIVE_ASSET: 'native',
	buildPublicClient: jest.fn(() => ({ client: true })),
	readAssetAmount: mockReadAssetAmount,
}));

jest.unstable_mockModule('./internal', () => ({
	assertHexAddress: jest.fn(),
	assertRpcServesDeclaredChain: jest.fn(),
	normalizeAddress: jest.fn((address: string) => address.toLowerCase()),
}));

const { evaluateX402LowBalanceRules } = await import('./low-balance');

describe('evaluateX402LowBalanceRules', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockRuleFindMany.mockResolvedValue([
			{
				id: 'rule-1',
				asset: 'native',
				thresholdAmount: 10n,
				status: 'Healthy',
				EvmWallet: {
					id: 'wallet-1',
					address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
					type: 'Purchasing',
					Network: { caip2Id: 'eip155:8453' },
				},
			},
		]);
		mockNetworkFindMany.mockResolvedValue([
			{
				caip2Id: 'eip155:8453',
				rpcUrl: 'https://rpc.example',
				displayName: 'Base',
			},
		]);
	});

	it('does not turn an EVM RPC failure into a zero balance or low-balance transition', async () => {
		mockReadAssetAmount.mockRejectedValueOnce(new Error('RPC unavailable'));

		await expect(evaluateX402LowBalanceRules()).resolves.toEqual([]);

		expect(mockRuleUpdate).not.toHaveBeenCalled();
		expect(mockLoggerWarn).toHaveBeenCalledWith(
			'x402 low-balance check failed for a rule',
			expect.objectContaining({
				ruleId: 'rule-1',
			}),
		);
	});
});
