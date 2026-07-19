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

describe('reconcileInFlightRequests', () => {
	const inFlight = (transaction: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
		id: 'req-1',
		batchId: 'batch-1',
		amount: 20_000_000n,
		assetUnit: 'lovelace',
		targetWalletId: 'w1',
		transactionId: 'tx-1',
		TargetWallet: { walletAddress: 'addr_target_w1', deletedAt: null },
		FundWallet: {
			id: 'fund-1',
			walletAddress: 'addr_fund',
			paymentSourceId: 'ps-1',
			deletedAt: null,
			FundDistributionConfig: { enabled: true },
			PaymentSource: { network: 'Preprod', deletedAt: null },
		},
		Transaction: {
			txHash: null,
			intendedTxHash: 'intended-1',
			status: TransactionStatus.Pending,
			createdAt: new Date(),
			...transaction,
		},
		...overrides,
	});

	it('adopts a reconciliation-promoted batch as Submitted', async () => {
		// reconcileOne promoted intendedTxHash -> txHash, meaning the tx IS on
		// chain. Re-sending would double-spend; the batch must move to Submitted
		// so the confirm phase picks it up.
		phaseRows['in-flight'] = [inFlight({ txHash: 'abc' })];

		await fundDistributionService.processDistributionCycle();

		expect(mockRequestUpdateMany).toHaveBeenCalledWith({
			where: { id: { in: ['req-1'] }, status: FundDistributionStatus.Pending },
			data: { status: FundDistributionStatus.Submitted, txHash: 'abc' },
		});
		expect(mockQueueSent).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({
				txHash: 'abc',
				batchId: 'batch-1',
				distributions: [expect.objectContaining({ assetUnit: 'lovelace' })],
			}),
			'ps-1',
		);
	});

	it('releases a rolled-back batch so it can be rebuilt', async () => {
		// TTL provably elapsed: the body can never land, so a fresh build with new
		// inputs is safe.
		phaseRows['in-flight'] = [inFlight({ status: TransactionStatus.RolledBack })];

		await fundDistributionService.processDistributionCycle();

		expect(mockRequestUpdateMany).toHaveBeenCalledWith({
			where: { id: { in: ['req-1'] }, status: FundDistributionStatus.Pending },
			data: { fundWalletId: null, transactionId: null, batchId: null },
		});
	});

	it('fails a rolled-back batch instead of rebuilding toward an inactive target', async () => {
		phaseRows['in-flight'] = [
			inFlight(
				{ status: TransactionStatus.RolledBack },
				{ TargetWallet: { walletAddress: 'addr_target_w1', deletedAt: new Date() } },
			),
		];

		await fundDistributionService.processDistributionCycle();

		expect(mockRequestUpdateMany).toHaveBeenCalledWith({
			where: { id: { in: ['req-1'] }, status: FundDistributionStatus.Pending },
			data: {
				status: FundDistributionStatus.Failed,
				error: 'Distribution cancelled because its payment source or wallet is inactive',
				transactionId: null,
			},
		});
	});

	it('releases a RolledBack batch even when it still carries a txHash', async () => {
		// tx-sync marks a Transaction RolledBack BY txHash and leaves the hash set.
		// Checking txHash first would promote a batch the chain already discarded,
		// stranding it until the 30min confirm timeout for no reason.
		phaseRows['in-flight'] = [inFlight({ txHash: 'abc', status: TransactionStatus.RolledBack })];

		await fundDistributionService.processDistributionCycle();

		expect(mockRequestUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: { fundWalletId: null, transactionId: null, batchId: null } }),
		);
		expect(mockRequestUpdateMany).not.toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: FundDistributionStatus.Submitted }) }),
		);
	});

	it('releases a never-broadcast orphan so its target is not stranded forever', async () => {
		// Crash between creating the Transaction and recording intendedTxHash:
		// nothing was signed, so nothing can be on chain. No other worker recovers
		// this — reconciliation only considers rows WITH an intendedTxHash. Left
		// linked, the row is excluded from rebuild AND counted as "already queued"
		// by the scan, so the target would never be topped up again.
		phaseRows['in-flight'] = [
			inFlight({ txHash: null, intendedTxHash: null, createdAt: new Date(Date.now() - 3_600_000) }),
		];

		await fundDistributionService.processDistributionCycle();

		expect(mockRequestUpdateMany).toHaveBeenCalledWith({
			where: { id: { in: ['req-1'] }, status: FundDistributionStatus.Pending },
			data: { fundWalletId: null, transactionId: null, batchId: null },
		});
	});

	it('leaves a fresh never-broadcast row alone until the lock timeout passes', async () => {
		// It may simply still be mid build/sign.
		phaseRows['in-flight'] = [inFlight({ txHash: null, intendedTxHash: null, createdAt: new Date() })];

		await fundDistributionService.processDistributionCycle();

		expect(mockRequestUpdateMany).not.toHaveBeenCalled();
	});

	it('leaves a signed, in-flight batch alone', async () => {
		phaseRows['in-flight'] = [inFlight({ txHash: null, intendedTxHash: 'intended-1' })];

		await fundDistributionService.processDistributionCycle();

		expect(mockRequestUpdateMany).not.toHaveBeenCalled();
	});
});

describe('confirmSubmittedRequests', () => {
	const submitted = (overrides: Record<string, unknown> = {}) => ({
		id: 'req-1',
		txHash: 'tx-hash-1',
		updatedAt: new Date(Date.now() - 600_000),
		fundWalletId: 'fund-1',
		batchId: 'batch-1',
		amount: 20_000_000n,
		assetUnit: 'lovelace',
		targetWalletId: 'w1',
		transactionId: 'tx-1',
		TargetWallet: { walletAddress: 'addr_target_w1' },
		FundWallet: {
			id: 'fund-1',
			walletAddress: 'addr_fund',
			lockedAt: new Date(),
			pendingTransactionId: 'tx-1',
			PaymentSource: { id: 'ps-1', PaymentSourceConfig: { rpcProviderApiKey: 'key' }, network: 'Preprod' },
		},
		...overrides,
	});

	it('only looks at rows old enough for the indexer to have seen', async () => {
		phaseRows.submitted = [submitted()];

		await fundDistributionService.processDistributionCycle();

		// Without the age filter a tx submitted this cycle looks not-found and is
		// marked Failed.
		expect(mockRequestFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					status: FundDistributionStatus.Submitted,
					txHash: { not: null },
					updatedAt: { lt: expect.any(Date) },
				}),
			}),
		);
	});

	it('confirms an in-flight batch after the last fund wallet is disabled', async () => {
		phaseRows.submitted = [submitted()];
		mockHotWalletFindMany.mockResolvedValue([]);
		mockLookupChainTx.mockResolvedValue('found');

		await fundDistributionService.processDistributionCycle();

		expect(mockQueueConfirmed).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({
				txHash: 'tx-hash-1',
				distributions: [expect.objectContaining({ assetUnit: 'lovelace' })],
			}),
			'ps-1',
		);
	});

	it('confirms a batch found on chain, touching only its own rows', async () => {
		phaseRows.submitted = [submitted()];
		mockLookupChainTx.mockResolvedValue('found');

		await fundDistributionService.processDistributionCycle();

		// Assert the WHERE, not just the data: an unscoped update would mark every
		// distribution in the table Confirmed and a data-only assertion would pass.
		expect(mockRequestUpdateMany).toHaveBeenCalledWith({
			where: { id: { in: ['req-1'] }, status: FundDistributionStatus.Submitted },
			data: { status: FundDistributionStatus.Confirmed, error: null },
		});
		expect(mockQueueConfirmed).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({ txHash: 'tx-hash-1' }),
			'ps-1',
		);
	});

	it('fails a batch absent from chain past the timeout, touching only its own rows', async () => {
		phaseRows.submitted = [submitted({ updatedAt: new Date(Date.now() - 3_600_000) })];
		mockLookupChainTx.mockResolvedValue('not-found');

		await fundDistributionService.processDistributionCycle();

		expect(mockRequestUpdateMany).toHaveBeenCalledWith({
			where: { id: { in: ['req-1'] }, status: FundDistributionStatus.Submitted },
			data: { status: FundDistributionStatus.Failed, error: 'Transaction not found on-chain after timeout' },
		});
		expect(mockQueueFailed).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({ txHash: 'tx-hash-1' }),
			'ps-1',
		);
	});

	it('keeps a not-yet-indexed batch Submitted and the wallet locked', async () => {
		phaseRows.submitted = [submitted({ updatedAt: new Date(Date.now() - 600_000) })];
		mockLookupChainTx.mockResolvedValue('not-found');

		await fundDistributionService.processDistributionCycle();

		// Within the confirmation timeout a 404 just means Blockfrost lags.
		expect(mockQueueFailed).not.toHaveBeenCalled();
		expect(mockHotWalletUpdateMany).not.toHaveBeenCalled();
	});

	it('does not fail or unlock a batch when the indexer is unhealthy', async () => {
		phaseRows.submitted = [submitted({ updatedAt: new Date(Date.now() - 3_600_000) })];
		mockLookupChainTx.mockResolvedValue('transient-error');

		await fundDistributionService.processDistributionCycle();

		// Inferring "not on chain" from a 5xx is how a landed tx gets marked Failed
		// and re-sent. Even past the timeout, a transient error must not fail it.
		expect(mockRequestUpdateMany).not.toHaveBeenCalled();
		expect(mockHotWalletUpdateMany).not.toHaveBeenCalled();
	});

	it('releases only the lock held by the batch it resolved', async () => {
		phaseRows.submitted = [submitted()];
		mockLookupChainTx.mockResolvedValue('found');

		await fundDistributionService.processDistributionCycle();

		// Clearing a lock we do not own lets the next cycle rebuild rows whose tx
		// is still in flight.
		expect(mockHotWalletUpdateMany).toHaveBeenCalledWith({
			where: { id: 'fund-1', pendingTransactionId: { in: ['tx-1'] } },
			data: { lockedAt: null, pendingTransactionId: null },
		});
		expect(mockTransactionUpdateMany).toHaveBeenCalledWith({
			where: { id: { in: ['tx-1'] }, status: TransactionStatus.Pending },
			data: { status: TransactionStatus.Confirmed, lastCheckedAt: expect.any(Date) },
		});
	});

	it('does not emit or unlock when another replica won the terminal transition', async () => {
		phaseRows.submitted = [submitted()];
		mockLookupChainTx.mockResolvedValue('found');
		mockRequestUpdateMany.mockResolvedValue({ count: 0 });

		await fundDistributionService.processDistributionCycle();

		expect(mockQueueConfirmed).not.toHaveBeenCalled();
		expect(mockHotWalletUpdateMany).not.toHaveBeenCalled();
	});
});
