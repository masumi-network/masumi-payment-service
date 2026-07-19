import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockGetFundWalletsForPaymentSource = jest.fn() as AnyMock;
const mockProcessRequests = jest.fn() as AnyMock;

// Models the atomic claim: a request handed to processRequestsForFundWallet is
// claimed by that wallet, so the dispatch loop's re-query no longer returns it
// and it falls through to the next wallet only if left unclaimed.
const claimedRequestIds = new Set<string>();

const mockRequestFindFirst = jest.fn() as AnyMock;
const mockRequestFindMany = jest.fn() as AnyMock;
const mockRequestCreate = jest.fn() as AnyMock;
const mockRequestUpdateMany = jest.fn() as AnyMock;
const mockHotWalletFindMany = jest.fn() as AnyMock;
const mockHotWalletFindFirst = jest.fn() as AnyMock;
const mockHotWalletFindUnique = jest.fn() as AnyMock;
const mockHotWalletUpdateMany = jest.fn() as AnyMock;
const mockLowBalanceRuleFindFirst = jest.fn() as AnyMock;
const mockTransactionUpdateMany = jest.fn() as AnyMock;
const mockLookupChainTx = jest.fn() as AnyMock;
const mockLoggerInfo = jest.fn() as AnyMock;
const mockQueueSent = jest.fn() as AnyMock;
const mockQueueConfirmed = jest.fn() as AnyMock;
const mockQueueFailed = jest.fn() as AnyMock;

/**
 * Rows each cycle phase should see, keyed by phase.
 *
 * A router, not ad-hoc branching in each test. The previous version matched on
 * one narrow predicate and returned [] for everything else, which silently made
 * three of the five phases unreachable in EVERY test — they passed while
 * proving nothing. Routing on each query's distinguishing predicate means a
 * phase that stops being reachable shows up as an unrouted-query throw rather
 * than a green run.
 */
type Phase = 'in-flight' | 'critical' | 'expired' | 'submitted';
const phaseRows: Record<Phase, unknown[]> = {
	'in-flight': [],
	critical: [],
	expired: [],
	submitted: [],
};

function routeFindMany(args: {
	where?: {
		status?: string;
		priority?: string | { in?: string[] };
		transactionId?: unknown;
	};
}): Phase {
	const where = args?.where ?? {};
	if (where.status === FundDistributionStatus.Submitted) return 'submitted';
	if (where.transactionId !== null && where.transactionId !== undefined) return 'in-flight';
	if (where.priority === FundDistributionPriority.Critical) return 'critical';
	if (
		where.priority === FundDistributionPriority.Warning ||
		(typeof where.priority === 'object' && where.priority?.in?.includes(FundDistributionPriority.Warning))
	) {
		return 'expired';
	}
	throw new Error(`Unrouted fundDistributionRequest.findMany: ${JSON.stringify(args?.where)}`);
}

const FundDistributionPriority = { Warning: 'Warning', Critical: 'Critical' } as const;
const FundDistributionStatus = {
	Pending: 'Pending',
	Submitted: 'Submitted',
	Confirmed: 'Confirmed',
	Failed: 'Failed',
} as const;
const TransactionStatus = {
	Pending: 'Pending',
	Confirmed: 'Confirmed',
	FailedViaTimeout: 'FailedViaTimeout',
	RolledBack: 'RolledBack',
} as const;
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
					fundDistributionRequest: {
						findFirst: mockRequestFindFirst,
						create: mockRequestCreate,
						updateMany: mockRequestUpdateMany,
					},
					transaction: { updateMany: mockTransactionUpdateMany },
					hotWallet: {
						findFirst: mockHotWalletFindFirst,
						updateMany: mockHotWalletUpdateMany,
					},
					hotWalletLowBalanceRule: {
						findFirst: mockLowBalanceRuleFindFirst,
					},
				});
			}
			return Promise.all(arg as Promise<unknown>[]);
		},
		hotWallet: {
			findMany: mockHotWalletFindMany,
			findFirst: mockHotWalletFindFirst,
			findUnique: mockHotWalletFindUnique,
			update: jest.fn(),
			updateMany: mockHotWalletUpdateMany,
		},
		fundDistributionRequest: {
			findFirst: mockRequestFindFirst,
			findMany: mockRequestFindMany,
			create: mockRequestCreate,
			updateMany: mockRequestUpdateMany,
		},
	},
}));

jest.unstable_mockModule('@masumi/payment-core/db-retry', () => ({
	retryOnSerializationConflict: async (fn: () => Promise<unknown>) => fn(),
}));

jest.unstable_mockModule('@/services/shared/chain-tx-lookup', () => ({
	lookupChainTx: mockLookupChainTx,
}));

jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONFIG: { WALLET_LOCK_TIMEOUT_INTERVAL: 300_000 },
	CONSTANTS: {
		FUND_DISTRIBUTION_TX_CONFIRMATION_TIMEOUT_MS: 1_800_000,
		FUND_DISTRIBUTION_DEFAULT_BATCH_WINDOW_MS: 300_000,
		FUND_DISTRIBUTION_CONFIRMATION_DELAY_MS: 300_000,
		FUND_DISTRIBUTION_FAILURE_RETRY_COOLDOWN_MS: 900_000,
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: mockLoggerInfo, warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@masumi/payment-core/blockchain-error-interpreter', () => ({
	interpretBlockchainError: (error: unknown) => String(error),
}));

jest.unstable_mockModule('@/services/webhooks', () => ({
	webhookEventsService: {
		queueFundDistributionSent: mockQueueSent,
		queueFundDistributionConfirmed: mockQueueConfirmed,
		queueFundDistributionFailed: mockQueueFailed,
	},
}));

jest.unstable_mockModule('./context', () => ({
	getFundWalletsForPaymentSource: mockGetFundWalletsForPaymentSource,
}));

jest.unstable_mockModule('./batch-executor', () => ({
	processRequestsForFundWallet: mockProcessRequests,
}));

let fundDistributionService: typeof import('./service').fundDistributionService;

beforeAll(async () => {
	({ fundDistributionService } = await import('./service'));
});

/** A realistic non-ADA unit: policy id + hex asset name, as low-balance rules store it. */
const USDM_UNIT = `${'c48cbb'.repeat(9)}dd0014df105553444d`;

const fundWallet = {
	id: 'fund-1',
	walletAddress: 'addr_fund',
	walletVkey: 'vkey',
	lowBalanceRules: new Map<string, { id: string; thresholdAmount: bigint; lastAlertedAt: Date | null }>([
		['lovelace', { id: 'rule-1', thresholdAmount: 10_000_000n, lastAlertedAt: null }],
	]),
	paymentSourceId: 'ps-1',
	paymentSourceType: 'Web3CardanoV1',
	network: 'Preprod',
	rpcProviderApiKey: 'key',
	encryptedMnemonic: 'enc',
	// A fund wallet holds no per-asset policy anymore: the threshold and amount
	// come from the hot wallet's rule, passed into requestTopup.
	config: { batchWindowMs: 300_000 },
};

beforeEach(() => {
	jest.clearAllMocks();
	for (const key of Object.keys(phaseRows) as Phase[]) phaseRows[key] = [];
	claimedRequestIds.clear();

	// A source has, by default, one fund wallet. Multi-wallet tests override this.
	mockGetFundWalletsForPaymentSource.mockResolvedValue([fundWallet]);
	mockRequestFindFirst.mockResolvedValue(null);
	mockRequestCreate.mockResolvedValue({ id: 'req-1' });
	// Dispatch re-queries the unassigned pool each fund-wallet iteration; drop the
	// rows a prior wallet already claimed so "first with funds" is observable.
	mockRequestFindMany.mockImplementation(async (args: any) =>
		(phaseRows[routeFindMany(args)] as Array<{ id?: string }>).filter((row) => !claimedRequestIds.has(row.id ?? '')),
	);
	mockRequestUpdateMany.mockImplementation(async (args: any) => ({ count: args?.where?.id?.in?.length ?? 0 }));
	mockTransactionUpdateMany.mockResolvedValue({ count: 1 });
	// The funded-source lookup (type: Funding) vs the low-balance scan.
	mockHotWalletFindMany.mockImplementation(async (args: any) =>
		args?.where?.type === HotWalletType.Funding ? [{ paymentSourceId: 'ps-1' }] : [],
	);
	mockHotWalletFindFirst.mockResolvedValue({ id: 'active' });
	mockLowBalanceRuleFindFirst.mockResolvedValue({ id: 'rule-1' });
	mockHotWalletFindUnique.mockResolvedValue({ walletAddress: 'addr_target' });
	mockHotWalletUpdateMany.mockResolvedValue({ count: 1 });
	// Default: the wallet claims every request it is handed. Underfunded-wallet
	// tests override this to claim nothing (so the request falls to the next).
	mockProcessRequests.mockImplementation(async (_wallet: unknown, requests: Array<{ id: string }>) => {
		for (const request of requests) claimedRequestIds.add(request.id);
	});
	mockLookupChainTx.mockResolvedValue('found');
});

describe('requestTopup', () => {
	// The trigger and amount now come from the hot wallet's rule, passed in.
	const topupParams = (currentBalance: bigint) => ({
		ruleId: 'rule-1',
		targetWalletId: 'w1',
		currentBalance,
		paymentSourceId: 'ps-1',
		assetUnit: 'lovelace',
		thresholdAmount: 10_000_000n,
		topupAmount: 20_000_000n,
		balanceCheckedAt: new Date('2026-07-19T00:00:00.000Z'),
	});

	it('does nothing when the payment source has no fund wallet', async () => {
		mockGetFundWalletsForPaymentSource.mockResolvedValue([]);

		await fundDistributionService.requestTopup(topupParams(4_000_000n));

		expect(mockRequestCreate).not.toHaveBeenCalled();
	});

	it('refuses to let a fund wallet fund itself', async () => {
		await fundDistributionService.requestTopup({ ...topupParams(4_000_000n), targetWalletId: 'fund-1' });

		expect(mockRequestCreate).not.toHaveBeenCalled();
	});

	it('does nothing at or above the rule threshold', async () => {
		await fundDistributionService.requestTopup(topupParams(10_000_000n));

		expect(mockRequestCreate).not.toHaveBeenCalled();
	});

	it('does not queue when the fund wallet became inactive before creation', async () => {
		mockHotWalletFindFirst.mockResolvedValueOnce(null);

		await fundDistributionService.requestTopup(topupParams(4_000_000n));

		expect(mockRequestCreate).not.toHaveBeenCalled();
	});

	it('does not queue when the target wallet became inactive before creation', async () => {
		mockHotWalletFindFirst.mockResolvedValueOnce({ id: 'fund-1' }).mockResolvedValueOnce(null);

		await fundDistributionService.requestTopup(topupParams(4_000_000n));

		expect(mockRequestCreate).not.toHaveBeenCalled();
	});

	it('does not queue from a stale scan after the rule changed or was deleted', async () => {
		mockLowBalanceRuleFindFirst.mockResolvedValue(null);

		await fundDistributionService.requestTopup(topupParams(4_000_000n));

		expect(mockRequestCreate).not.toHaveBeenCalled();
	});

	it('revalidates the exact observed rule before creating a request', async () => {
		const params = topupParams(4_000_000n);

		await fundDistributionService.requestTopup(params);

		expect(mockLowBalanceRuleFindFirst).toHaveBeenCalledWith({
			where: {
				id: 'rule-1',
				hotWalletId: 'w1',
				assetUnit: 'lovelace',
				enabled: true,
				topupEnabled: true,
				thresholdAmount: 10_000_000n,
				topupAmount: 20_000_000n,
				lastCheckedAt: params.balanceCheckedAt,
				lastKnownAmount: 4_000_000n,
			},
			select: { id: true },
		});
	});

	it('creates an unassigned Warning request with the rule amount, and does not dispatch', async () => {
		await fundDistributionService.requestTopup(topupParams(4_000_000n));

		// The amount is the rule's topupAmount, not anything on the fund wallet.
		expect(mockRequestCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					fundWalletId: null,
					priority: FundDistributionPriority.Warning,
					assetUnit: 'lovelace',
					amount: 20_000_000n,
				}),
			}),
		);
		// requestTopup only records the shortage; sending happens in the batched cycle.
		expect(mockProcessRequests).not.toHaveBeenCalled();
	});

	it('dedupes across fund wallets: no second request while one is in flight', async () => {
		mockRequestFindFirst.mockResolvedValue({ id: 'existing' });

		await fundDistributionService.requestTopup(topupParams(4_000_000n));

		expect(mockRequestCreate).not.toHaveBeenCalled();
	});

	it('does not re-send a confirmed top-up until monitoring records a newer balance', async () => {
		const balanceCheckedAt = new Date('2026-07-19T00:00:00.000Z');
		mockRequestFindFirst.mockImplementation((args: any) => {
			expect(args.where.OR).toContainEqual({
				status: FundDistributionStatus.Confirmed,
				updatedAt: { gte: balanceCheckedAt },
			});
			return { id: 'confirmed-after-observation' };
		});

		await fundDistributionService.requestTopup({
			...topupParams(4_000_000n),
			balanceCheckedAt,
		});

		expect(mockRequestCreate).not.toHaveBeenCalled();
	});

	it('treats a serialization conflict as a duplicate, not an error', async () => {
		// Two concurrent callers (scheduled cycle + low-balance alert) can race;
		// the loser must not propagate P2034 to its caller.
		mockRequestFindFirst.mockImplementation(() => {
			throw Object.assign(new Error('conflict'), { code: 'P2034' });
		});

		await expect(fundDistributionService.requestTopup(topupParams(4_000_000n))).resolves.toBeUndefined();
	});
});

describe('processDistributionCycle', () => {
	it('still runs lifecycle phases when no enabled fund wallet is configured', async () => {
		mockHotWalletFindMany.mockResolvedValue([]);

		await fundDistributionService.processDistributionCycle();

		expect(mockRequestFindMany).toHaveBeenCalledTimes(2);
		expect(mockProcessRequests).not.toHaveBeenCalled();
	});

	const rule = (
		assetUnit: string,
		thresholdAmount: bigint,
		topupAmount: bigint,
		lastKnownAmount: bigint,
		lastCheckedAt = new Date(),
	) => ({
		id: `rule-${assetUnit}`,
		assetUnit,
		thresholdAmount,
		topupAmount,
		lastKnownAmount,
		lastCheckedAt,
	});
	const scanReturns = (
		rules: Array<{
			assetUnit: string;
			thresholdAmount: bigint;
			topupAmount: bigint;
			lastKnownAmount: bigint;
			lastCheckedAt: Date;
		}>,
	) =>
		mockHotWalletFindMany.mockImplementation(async (args: any) =>
			args?.where?.type === HotWalletType.Funding
				? [{ paymentSourceId: 'ps-1' }]
				: [{ id: 'w1', paymentSourceId: 'ps-1', LowBalanceRules: rules }],
		);

	it('creates a Warning topup with the rule amount when below the rule threshold', async () => {
		scanReturns([rule('lovelace', 10_000_000n, 20_000_000n, 4_000_000n)]);

		await fundDistributionService.processDistributionCycle();

		expect(mockRequestCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					assetUnit: 'lovelace',
					priority: FundDistributionPriority.Warning,
					amount: 20_000_000n,
				}),
			}),
		);
	});

	it('scans every monitored asset, not just ADA', async () => {
		scanReturns([rule(USDM_UNIT, 100_000_000n, 250_000_000n, 10_000_000n)]);

		await fundDistributionService.processDistributionCycle();

		expect(mockRequestCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ assetUnit: USDM_UNIT, amount: 250_000_000n }),
			}),
		);
	});

	it('does not top up at or above the rule threshold', async () => {
		scanReturns([rule('lovelace', 10_000_000n, 20_000_000n, 10_000_000n)]);

		await fundDistributionService.processDistributionCycle();

		expect(mockRequestCreate).not.toHaveBeenCalled();
	});

	it('only scans rules that asked for auto top-up', async () => {
		await fundDistributionService.processDistributionCycle();

		// The trigger lives on the rule: the scan must filter on topupEnabled, so a
		// wallet with only alert-only rules is never funded.
		const scanWhere = mockHotWalletFindMany.mock.calls
			.map((call: any) => call[0]?.where)
			.find((where: any) => where?.type?.not === HotWalletType.Funding);
		expect(scanWhere?.LowBalanceRules?.some).toMatchObject({ topupEnabled: true });
	});

	it('does not let an in-flight ADA topup hide a token shortage on the same wallet', async () => {
		scanReturns([
			rule('lovelace', 10_000_000n, 20_000_000n, 1_000_000n),
			rule(USDM_UNIT, 100_000_000n, 250_000_000n, 1_000_000n),
		]);

		await fundDistributionService.processDistributionCycle();

		// The scan must not be gated on FundDistributionsReceived: that predicate
		// is asset-blind, so one in-flight top-up would suppress every other
		// asset's. Dedupe is scoped to (target, asset) in requestTopup instead.
		const scanWhere = mockHotWalletFindMany.mock.calls
			.map((call: any) => call[0]?.where)
			.find((where: any) => where?.type?.not === HotWalletType.Funding);
		expect(scanWhere).not.toHaveProperty('FundDistributionsReceived');

		const createdAssets = mockRequestCreate.mock.calls.map((call: any) => call[0]?.data?.assetUnit);
		expect(createdAssets).toEqual(['lovelace', USDM_UNIT]);
	});

	it('does not discover fund wallets under a deleted payment source', async () => {
		await fundDistributionService.processDistributionCycle();

		expect(mockHotWalletFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					type: HotWalletType.Funding,
					PaymentSource: { deletedAt: null },
				}),
			}),
		);
	});
});

// A second fund wallet on the same source, distinct id/address.
const fundWallet2 = { ...fundWallet, id: 'fund-2', walletAddress: 'addr_fund_2' };

describe('batched dispatch', () => {
	// Older than the default 5-minute window, so the batch is due to send.
	const past = () => new Date(Date.now() - 600_000);
	const warningRow = (
		id: string,
		targetWalletId: string,
		walletAddress: string,
		amount: bigint,
		createdAt = past(),
	) => ({
		id,
		targetWalletId,
		assetUnit: 'lovelace',
		amount,
		createdAt,
		TargetWallet: { walletAddress, paymentSourceId: 'ps-1' },
	});

	it('batches all due rows into one call, routed to the right addresses', async () => {
		phaseRows.expired = [
			warningRow('req-1', 'w1', 'addr_w1', 20_000_000n),
			warningRow('req-2', 'w2', 'addr_w2', 30_000_000n),
		];

		await fundDistributionService.processDistributionCycle();

		// Batching is the feature's whole point: both rows must reach ONE call.
		expect(mockProcessRequests).toHaveBeenCalledWith(fundWallet, [
			{ id: 'req-1', targetWalletId: 'w1', targetAddress: 'addr_w1', assetUnit: 'lovelace', amount: 20_000_000n },
			{ id: 'req-2', targetWalletId: 'w2', targetAddress: 'addr_w2', assetUnit: 'lovelace', amount: 30_000_000n },
		]);
	});

	it('dispatches legacy Critical rows through the single-tier batch', async () => {
		phaseRows.expired = [warningRow('req-critical', 'w1', 'addr_w1', 20_000_000n)];

		await fundDistributionService.processDistributionCycle();

		const pendingQueries = mockRequestFindMany.mock.calls
			.map((call: any) => call[0]?.where?.priority)
			.filter((priority: unknown) => priority != null);
		expect(pendingQueries).toContainEqual({
			in: [FundDistributionPriority.Warning, FundDistributionPriority.Critical],
		});
		expect(mockProcessRequests).toHaveBeenCalledWith(fundWallet, [expect.objectContaining({ id: 'req-critical' })]);
	});

	it('holds a batch inside its window so more topups can join it', async () => {
		phaseRows.expired = [warningRow('req-1', 'w1', 'addr_w1', 20_000_000n, new Date())];

		await fundDistributionService.processDistributionCycle();

		expect(mockProcessRequests).not.toHaveBeenCalled();
	});

	it('uses the most eager (smallest) batch window among the source fund wallets', async () => {
		mockGetFundWalletsForPaymentSource.mockResolvedValue([
			{ ...fundWallet, config: { batchWindowMs: 300_000 } },
			{ ...fundWallet2, config: { batchWindowMs: 10_000 } },
		]);
		phaseRows.expired = [warningRow('req-1', 'w1', 'addr_w1', 20_000_000n, new Date(Date.now() - 30_000))];

		await fundDistributionService.processDistributionCycle();

		expect(mockProcessRequests).toHaveBeenCalled();
	});

	it('only ever queries unassigned rows off an in-flight transaction', async () => {
		await fundDistributionService.processDistributionCycle();

		// The lock is not the only thing standing between an in-flight batch and a
		// second send — wallet-timeouts can free it with no coordination — so the
		// query itself must exclude assigned/linked rows.
		expect(mockRequestFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					priority: {
						in: [FundDistributionPriority.Warning, FundDistributionPriority.Critical],
					},
					status: FundDistributionStatus.Pending,
					fundWalletId: null,
					transactionId: null,
					TargetWallet: { deletedAt: null, PaymentSource: { deletedAt: null } },
				}),
			}),
		);
	});

	it('falls through to the next fund wallet when the first cannot fund the shortage', async () => {
		mockGetFundWalletsForPaymentSource.mockResolvedValue([fundWallet, fundWallet2]);
		phaseRows.expired = [warningRow('req-1', 'w1', 'addr_w1', 20_000_000n)];

		// The oldest wallet is broke: handed the request, it claims nothing, so the
		// re-query still returns it and the second wallet picks it up. "First with
		// funds" — not "first in the list".
		mockProcessRequests.mockImplementation(async (wallet: { id: string }, requests: Array<{ id: string }>) => {
			if (wallet.id === 'fund-1') return; // underfunded: claims nothing
			for (const request of requests) claimedRequestIds.add(request.id);
		});

		await fundDistributionService.processDistributionCycle();

		expect(mockProcessRequests).toHaveBeenNthCalledWith(1, fundWallet, expect.any(Array));
		expect(mockProcessRequests).toHaveBeenNthCalledWith(2, fundWallet2, [
			{ id: 'req-1', targetWalletId: 'w1', targetAddress: 'addr_w1', assetUnit: 'lovelace', amount: 20_000_000n },
		]);
	});

	it('does not re-offer a request the first fund wallet already claimed', async () => {
		mockGetFundWalletsForPaymentSource.mockResolvedValue([fundWallet, fundWallet2]);
		phaseRows.expired = [warningRow('req-1', 'w1', 'addr_w1', 20_000_000n)];

		await fundDistributionService.processDistributionCycle();

		expect(mockProcessRequests).toHaveBeenCalledTimes(1);
		expect(mockProcessRequests).toHaveBeenCalledWith(fundWallet, expect.any(Array));
	});
});
