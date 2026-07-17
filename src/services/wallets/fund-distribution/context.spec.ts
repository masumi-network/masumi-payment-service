import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindFirst = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hotWallet: { findFirst: mockFindFirst } },
}));

const { getFundWalletForPaymentSource, loadFundWalletContext } = await import('./context');

// A row exactly as FUND_WALLET_SELECT shapes it. The null-guard tests knock
// out one leg each to prove the mapper refuses to hand the executor a wallet
// it cannot spend from (no secret), should not spend from (disabled), or
// cannot look up balances for (no RPC key).
const completeRow = () => ({
	id: 'fund-1',
	walletAddress: 'addr_fund',
	walletVkey: 'vkey_fund',
	paymentSourceId: 'ps-1',
	LowBalanceRules: [{ id: 'rule-1', lastAlertedAt: null }],
	Secret: { encryptedMnemonic: 'enc' },
	PaymentSource: {
		network: 'Preprod',
		paymentSourceType: 'Web3CardanoV1',
		PaymentSourceConfig: { rpcProviderApiKey: 'rpc-key' },
	},
	FundDistributionConfig: {
		enabled: true,
		warningThreshold: 10_000_000n,
		criticalThreshold: 5_000_000n,
		topupAmount: 20_000_000n,
		batchWindowMs: 300_000,
	},
});

describe('fund wallet context', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockFindFirst.mockResolvedValue(null);
	});

	it('does not resolve a fund wallet under a deleted payment source', async () => {
		await getFundWalletForPaymentSource('ps-1');

		expect(mockFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					paymentSourceId: 'ps-1',
					PaymentSource: { deletedAt: null },
				}),
			}),
		);
	});

	it('rejects a stale context load after its payment source is deleted', async () => {
		await loadFundWalletContext('fund-1');

		expect(mockFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: 'fund-1',
					PaymentSource: { deletedAt: null },
				}),
			}),
		);
	});

	it('maps a complete row into the executor context', async () => {
		mockFindFirst.mockResolvedValue(completeRow());

		await expect(getFundWalletForPaymentSource('ps-1')).resolves.toEqual({
			id: 'fund-1',
			walletAddress: 'addr_fund',
			walletVkey: 'vkey_fund',
			lowBalanceRule: { id: 'rule-1', lastAlertedAt: null },
			paymentSourceId: 'ps-1',
			paymentSourceType: 'Web3CardanoV1',
			network: 'Preprod',
			rpcProviderApiKey: 'rpc-key',
			encryptedMnemonic: 'enc',
			config: {
				warningThreshold: 10_000_000n,
				criticalThreshold: 5_000_000n,
				topupAmount: 20_000_000n,
				batchWindowMs: 300_000,
			},
		});
	});

	it('returns null when the wallet has no secret', async () => {
		mockFindFirst.mockResolvedValue({ ...completeRow(), Secret: null });

		await expect(getFundWalletForPaymentSource('ps-1')).resolves.toBeNull();
	});

	it('returns null when distribution is disabled or the config is missing', async () => {
		const disabled = completeRow();
		disabled.FundDistributionConfig.enabled = false;
		mockFindFirst.mockResolvedValue(disabled);
		await expect(getFundWalletForPaymentSource('ps-1')).resolves.toBeNull();

		mockFindFirst.mockResolvedValue({ ...completeRow(), FundDistributionConfig: null });
		await expect(loadFundWalletContext('fund-1')).resolves.toBeNull();
	});

	it('returns null when the RPC provider key is missing or blank', async () => {
		const withoutConfig = completeRow();
		withoutConfig.PaymentSource.PaymentSourceConfig = null as never;
		mockFindFirst.mockResolvedValue(withoutConfig);
		await expect(getFundWalletForPaymentSource('ps-1')).resolves.toBeNull();

		const withBlankKey = completeRow();
		withBlankKey.PaymentSource.PaymentSourceConfig.rpcProviderApiKey = '';
		mockFindFirst.mockResolvedValue(withBlankKey);
		await expect(getFundWalletForPaymentSource('ps-1')).resolves.toBeNull();
	});

	it('reports a missing low-balance rule as null rather than a dangling id', async () => {
		mockFindFirst.mockResolvedValue({ ...completeRow(), LowBalanceRules: [] });

		const context = await getFundWalletForPaymentSource('ps-1');

		expect(context?.lowBalanceRule).toBeNull();
	});
});
