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
	LowBalanceRules: [{ id: 'rule-1', assetUnit: 'lovelace', lastAlertedAt: null }],
	Secret: { encryptedMnemonic: 'enc' },
	PaymentSource: {
		network: 'Preprod',
		paymentSourceType: 'Web3CardanoV1',
		PaymentSourceConfig: { rpcProviderApiKey: 'rpc-key' },
	},
	FundDistributionConfig: {
		enabled: true,
		batchWindowMs: 300_000,
		AssetConfigs: [
			{
				assetUnit: 'lovelace',
				warningThreshold: 10_000_000n,
				criticalThreshold: 5_000_000n,
				topupAmount: 20_000_000n,
			},
		],
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
			lowBalanceRules: new Map([['lovelace', { id: 'rule-1', assetUnit: 'lovelace', lastAlertedAt: null }]]),
			paymentSourceId: 'ps-1',
			paymentSourceType: 'Web3CardanoV1',
			network: 'Preprod',
			rpcProviderApiKey: 'rpc-key',
			encryptedMnemonic: 'enc',
			config: {
				batchWindowMs: 300_000,
				assets: new Map([
					[
						'lovelace',
						{
							assetUnit: 'lovelace',
							warningThreshold: 10_000_000n,
							criticalThreshold: 5_000_000n,
							topupAmount: 20_000_000n,
						},
					],
				]),
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

	it('reports a missing low-balance rule as absent rather than a dangling id', async () => {
		mockFindFirst.mockResolvedValue({ ...completeRow(), LowBalanceRules: [] });

		const context = await getFundWalletForPaymentSource('ps-1');

		expect(context?.lowBalanceRules.get('lovelace')).toBeUndefined();
	});

	it('keys low-balance rules by asset so an alert can name the asset that is short', async () => {
		mockFindFirst.mockResolvedValue({
			...completeRow(),
			LowBalanceRules: [
				{ id: 'rule-ada', assetUnit: 'lovelace', lastAlertedAt: null },
				{ id: 'rule-usdm', assetUnit: 'usdm-unit', lastAlertedAt: null },
			],
		});

		const context = await getFundWalletForPaymentSource('ps-1');

		expect(context?.lowBalanceRules.get('usdm-unit')?.id).toBe('rule-usdm');
	});

	it('exposes per-asset policy keyed by assetUnit', async () => {
		mockFindFirst.mockResolvedValue({
			...completeRow(),
			FundDistributionConfig: {
				enabled: true,
				batchWindowMs: 300_000,
				AssetConfigs: [
					{ assetUnit: 'lovelace', warningThreshold: 10n, criticalThreshold: 5n, topupAmount: 20n },
					{ assetUnit: 'usdm-unit', warningThreshold: 100n, criticalThreshold: 50n, topupAmount: 200n },
				],
			},
		});

		const context = await getFundWalletForPaymentSource('ps-1');

		// A USDM threshold is not a lovelace threshold; each asset carries its own.
		expect(context?.config.assets.get('usdm-unit')?.topupAmount).toBe(200n);
		expect(context?.config.assets.get('lovelace')?.topupAmount).toBe(20n);
	});
});
