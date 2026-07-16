import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockGetFundWalletForPaymentSource = jest.fn() as AnyMock;
const mockLoadFundWalletContext = jest.fn() as AnyMock;
const mockProcessRequests = jest.fn() as AnyMock;

const mockRequestFindFirst = jest.fn() as AnyMock;
const mockRequestFindMany = jest.fn() as AnyMock;
const mockRequestCreate = jest.fn() as AnyMock;
const mockRequestUpdateMany = jest.fn() as AnyMock;
const mockHotWalletFindMany = jest.fn() as AnyMock;
const mockHotWalletFindUnique = jest.fn() as AnyMock;

const FundDistributionPriority = { Warning: 'Warning', Critical: 'Critical' } as const;
const FundDistributionStatus = {
	Pending: 'Pending',
	Submitted: 'Submitted',
	Confirmed: 'Confirmed',
	Failed: 'Failed',
} as const;
const TransactionStatus = { Pending: 'Pending', Confirmed: 'Confirmed', RolledBack: 'RolledBack' } as const;
const HotWalletType = { Purchasing: 'Purchasing', Selling: 'Selling', Funding: 'Funding' } as const;

jest.unstable_mockModule('@/generated/prisma/client', () => ({
	FundDistributionPriority,
	FundDistributionStatus,
	TransactionStatus,
	HotWalletType,
	Network: { Mainnet: 'Mainnet', Preprod: 'Preprod' },
	LowBalanceStatus: { Unknown: 'Unknown', Low: 'Low', Healthy: 'Healthy' },
}));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		$transaction: async (arg: unknown) => {
			if (typeof arg === 'function') {
				return (arg as (tx: unknown) => Promise<unknown>)({
					fundDistributionRequest: { findFirst: mockRequestFindFirst, create: mockRequestCreate },
				});
			}
			return Promise.all(arg as Promise<unknown>[]);
		},
		hotWallet: { findMany: mockHotWalletFindMany, findUnique: mockHotWalletFindUnique, update: jest.fn() },
		fundDistributionRequest: {
			findFirst: mockRequestFindFirst,
			findMany: mockRequestFindMany,
			create: mockRequestCreate,
			updateMany: mockRequestUpdateMany,
		},
	},
}));

jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONSTANTS: {
		FUND_DISTRIBUTION_TX_CONFIRMATION_TIMEOUT_MS: 1_800_000,
		FUND_DISTRIBUTION_DEFAULT_BATCH_WINDOW_MS: 300_000,
		FUND_DISTRIBUTION_CONFIRMATION_DELAY_MS: 300_000,
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@masumi/payment-core/blockchain-error-interpreter', () => ({
	interpretBlockchainError: (error: unknown) => String(error),
}));

jest.unstable_mockModule('@/services/webhooks', () => ({
	webhookEventsService: {
		triggerFundDistributionConfirmed: jest.fn(),
		triggerFundDistributionFailed: jest.fn(),
	},
}));

jest.unstable_mockModule('./context', () => ({
	getFundWalletForPaymentSource: mockGetFundWalletForPaymentSource,
	loadFundWalletContext: mockLoadFundWalletContext,
}));

jest.unstable_mockModule('./batch-executor', () => ({
	processRequestsForFundWallet: mockProcessRequests,
}));

let FundDistributionService: typeof import('./service').FundDistributionService;

beforeAll(async () => {
	({ FundDistributionService } = await import('./service'));
});

const fundWallet = {
	id: 'fund-1',
	walletAddress: 'addr_fund',
	walletVkey: 'vkey',
	lowBalanceRuleId: 'rule-1',
	paymentSourceId: 'ps-1',
	paymentSourceType: 'Web3CardanoV1',
	network: 'Preprod',
	rpcProviderApiKey: 'key',
	encryptedMnemonic: 'enc',
	config: {
		warningThreshold: 10_000_000n,
		criticalThreshold: 5_000_000n,
		topupAmount: 20_000_000n,
		batchWindowMs: 300_000,
	},
};

beforeEach(() => {
	jest.clearAllMocks();
	mockGetFundWalletForPaymentSource.mockResolvedValue(fundWallet);
	mockRequestFindFirst.mockResolvedValue(null);
	mockRequestCreate.mockResolvedValue({ id: 'req-1' });
	mockRequestFindMany.mockResolvedValue([]);
	mockRequestUpdateMany.mockResolvedValue({ count: 0 });
	mockHotWalletFindMany.mockResolvedValue([]);
});

describe('requestTopup', () => {
	it('does nothing when the payment source has no fund wallet', async () => {
		mockGetFundWalletForPaymentSource.mockResolvedValue(null);

		await new FundDistributionService().requestTopup({
			targetWalletId: 'w1',
			currentBalance: 1_000_000n,
			paymentSourceId: 'ps-1',
		});

		expect(mockRequestCreate).not.toHaveBeenCalled();
	});

	it('refuses to let a fund wallet fund itself', async () => {
		await new FundDistributionService().requestTopup({
			targetWalletId: 'fund-1',
			currentBalance: 1_000_000n,
			paymentSourceId: 'ps-1',
		});

		expect(mockRequestCreate).not.toHaveBeenCalled();
	});

	it('classifies a balance below the critical threshold as Critical', async () => {
		await new FundDistributionService().requestTopup({
			targetWalletId: 'w1',
			currentBalance: 4_000_000n,
			paymentSourceId: 'ps-1',
		});

		expect(mockRequestCreate).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ priority: FundDistributionPriority.Critical }) }),
		);
	});

	it('classifies a balance above the critical threshold as Warning', async () => {
		await new FundDistributionService().requestTopup({
			targetWalletId: 'w1',
			currentBalance: 8_000_000n,
			paymentSourceId: 'ps-1',
		});

		expect(mockRequestCreate).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ priority: FundDistributionPriority.Warning }) }),
		);
	});

	it('does not queue a second request while one is in flight', async () => {
		mockRequestFindFirst.mockResolvedValue({ id: 'existing' });

		await new FundDistributionService().requestTopup({
			targetWalletId: 'w1',
			currentBalance: 4_000_000n,
			paymentSourceId: 'ps-1',
		});

		expect(mockRequestCreate).not.toHaveBeenCalled();
	});

	it('treats a serialization conflict as a duplicate, not an error', async () => {
		// Two concurrent callers (scheduled cycle + low-balance alert) can race;
		// the loser must not propagate P2034 to its caller.
		mockRequestFindFirst.mockImplementation(() => {
			throw Object.assign(new Error('conflict'), { code: 'P2034' });
		});

		await expect(
			new FundDistributionService().requestTopup({
				targetWalletId: 'w1',
				currentBalance: 4_000_000n,
				paymentSourceId: 'ps-1',
			}),
		).resolves.toBeUndefined();
	});
});

describe('processDistributionCycle', () => {
	it('bails immediately when no fund wallet is configured', async () => {
		mockHotWalletFindMany.mockResolvedValue([]);

		await new FundDistributionService().processDistributionCycle();

		// The feature is opt-in; an unconfigured deployment must not pay for a
		// low-balance scan every cycle, forever.
		expect(mockRequestFindMany).not.toHaveBeenCalled();
		expect(mockProcessRequests).not.toHaveBeenCalled();
	});
});

describe('reconcileInFlightRequests', () => {
	const inFlight = (overrides: Record<string, unknown>) => ({
		id: 'req-1',
		batchId: 'batch-1',
		transactionId: 'tx-1',
		...overrides,
	});

	beforeEach(() => {
		// The cycle issues two hotWallet.findMany queries: the funded-source
		// lookup (type: Funding) and the low-balance scan (type: not Funding).
		// Branch on the type clause so the scan gets rows of the right shape.
		mockHotWalletFindMany.mockImplementation(async (args: any) => {
			if (args?.where?.type === HotWalletType.Funding) return [{ paymentSourceId: 'ps-1' }];
			return [];
		});
	});

	it('adopts a reconciliation-promoted batch as Submitted', async () => {
		// reconcileOne promoted intendedTxHash -> txHash, meaning the tx IS on
		// chain. Re-sending would double-spend; the batch must move to Submitted
		// so the confirm phase picks it up.
		mockRequestFindMany.mockImplementation(async (args: any) => {
			if (args?.where?.transactionId?.not === null) {
				return [inFlight({ Transaction: { txHash: 'abc', status: TransactionStatus.Pending } })];
			}
			return [];
		});

		await new FundDistributionService().processDistributionCycle();

		expect(mockRequestUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: { status: FundDistributionStatus.Submitted, txHash: 'abc' },
			}),
		);
	});

	it('releases a rolled-back batch so it can be rebuilt', async () => {
		// TTL provably elapsed and reconcileOne freed the wallet: the body can
		// never land, so a fresh build with new inputs is safe.
		mockRequestFindMany.mockImplementation(async (args: any) => {
			if (args?.where?.transactionId?.not === null) {
				return [inFlight({ Transaction: { txHash: null, status: TransactionStatus.RolledBack } })];
			}
			return [];
		});

		await new FundDistributionService().processDistributionCycle();

		expect(mockRequestUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: { transactionId: null, batchId: null } }),
		);
	});

	it('leaves a still-in-flight batch alone', async () => {
		mockRequestFindMany.mockImplementation(async (args: any) => {
			if (args?.where?.transactionId?.not === null) {
				return [inFlight({ Transaction: { txHash: null, status: TransactionStatus.Pending } })];
			}
			return [];
		});

		await new FundDistributionService().processDistributionCycle();

		const touchedIds = mockRequestUpdateMany.mock.calls.map((call: any) => call[0]?.where?.id);
		expect(touchedIds).not.toContainEqual({ in: ['req-1'] });
	});
});
