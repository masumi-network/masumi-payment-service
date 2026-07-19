import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindFirst = jest.fn() as AnyMock;
const mockFindMany = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hotWallet: { findFirst: mockFindFirst, findMany: mockFindMany } },
}));

const { getFundWalletsForPaymentSource, loadFundWalletContext } = await import('./context');

// A row exactly as FUND_WALLET_SELECT shapes it. The null-guard tests knock
// out one leg each to prove the mapper refuses to hand the executor a wallet
// it cannot spend from (no secret), should not spend from (disabled), or
// cannot look up balances for (no RPC key).
const completeRow = () => ({
	id: 'fund-1',
	walletAddress: 'addr_fund',
	walletVkey: 'vkey_fund',
	paymentSourceId: 'ps-1',
	LowBalanceRules: [{ id: 'rule-1', assetUnit: 'lovelace', thresholdAmount: 5_000_000n, lastAlertedAt: null }],
	Secret: { encryptedMnemonic: 'enc' },
	PaymentSource: {
		network: 'Preprod',
		paymentSourceType: 'Web3CardanoV1',
		PaymentSourceConfig: { rpcProviderApiKey: 'rpc-key' },
	},
	FundDistributionConfig: {
		enabled: true,
		batchWindowMs: 300_000,
	},
});

describe('fund wallet context', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockFindFirst.mockResolvedValue(null);
		mockFindMany.mockResolvedValue([]);
	});

	it('does not resolve a fund wallet under a deleted payment source', async () => {
		await getFundWalletsForPaymentSource('ps-1');

		expect(mockFindMany).toHaveBeenCalledWith(
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
		mockFindMany.mockResolvedValue([completeRow()]);

		await expect(getFundWalletsForPaymentSource('ps-1')).resolves.toEqual([
			{
				id: 'fund-1',
				walletAddress: 'addr_fund',
				walletVkey: 'vkey_fund',
				lowBalanceRules: new Map([
					[
						'lovelace',
						{
							id: 'rule-1',
							assetUnit: 'lovelace',
							thresholdAmount: 5_000_000n,
							lastAlertedAt: null,
						},
					],
				]),
				paymentSourceId: 'ps-1',
				paymentSourceType: 'Web3CardanoV1',
				network: 'Preprod',
				rpcProviderApiKey: 'rpc-key',
				encryptedMnemonic: 'enc',
				config: { batchWindowMs: 300_000 },
			},
		]);
	});

	it('returns null when the wallet has no secret', async () => {
		mockFindMany.mockResolvedValue([{ ...completeRow(), Secret: null }]);

		await expect(getFundWalletsForPaymentSource('ps-1')).resolves.toEqual([]);
	});

	it('returns null when distribution is disabled or the config is missing', async () => {
		const disabled = completeRow();
		disabled.FundDistributionConfig.enabled = false;
		mockFindMany.mockResolvedValue([disabled]);
		await expect(getFundWalletsForPaymentSource('ps-1')).resolves.toEqual([]);

		mockFindFirst.mockResolvedValue({ ...completeRow(), FundDistributionConfig: null });
		await expect(loadFundWalletContext('fund-1')).resolves.toBeNull();
	});

	it('returns null when the RPC provider key is missing or blank', async () => {
		const withoutConfig = completeRow();
		withoutConfig.PaymentSource.PaymentSourceConfig = null as never;
		mockFindMany.mockResolvedValue([withoutConfig]);
		await expect(getFundWalletsForPaymentSource('ps-1')).resolves.toEqual([]);

		const withBlankKey = completeRow();
		withBlankKey.PaymentSource.PaymentSourceConfig.rpcProviderApiKey = '';
		mockFindMany.mockResolvedValue([withBlankKey]);
		await expect(getFundWalletsForPaymentSource('ps-1')).resolves.toEqual([]);
	});

	it('reports a missing low-balance rule as absent rather than a dangling id', async () => {
		mockFindMany.mockResolvedValue([{ ...completeRow(), LowBalanceRules: [] }]);

		const [context] = await getFundWalletsForPaymentSource('ps-1');

		expect(context?.lowBalanceRules.get('lovelace')).toBeUndefined();
	});

	it('keys low-balance rules by asset so an alert can name the asset that is short', async () => {
		mockFindMany.mockResolvedValue([
			{
				...completeRow(),
				LowBalanceRules: [
					{ id: 'rule-ada', assetUnit: 'lovelace', thresholdAmount: 5_000_000n, lastAlertedAt: null },
					{ id: 'rule-usdm', assetUnit: 'usdm-unit', thresholdAmount: 10n, lastAlertedAt: null },
				],
			},
		]);

		const [context] = await getFundWalletsForPaymentSource('ps-1');

		expect(context?.lowBalanceRules.get('usdm-unit')?.id).toBe('rule-usdm');
	});

	it('exposes the batch window; the fund wallet carries no per-asset policy', async () => {
		mockFindMany.mockResolvedValue([completeRow()]);

		const [context] = await getFundWalletsForPaymentSource('ps-1');

		// Thresholds/amounts live on the hot wallet's rule now, not here.
		expect(context?.config).toEqual({ batchWindowMs: 300_000 });
	});
});
