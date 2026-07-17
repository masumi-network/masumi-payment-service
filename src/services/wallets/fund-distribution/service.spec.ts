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
const mockHotWalletUpdateMany = jest.fn() as AnyMock;
const mockLookupChainTx = jest.fn() as AnyMock;
const mockTriggerConfirmed = jest.fn() as AnyMock;
const mockTriggerFailed = jest.fn() as AnyMock;

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
		priority?: string;
		transactionId?: unknown;
	};
}): Phase {
	const where = args?.where ?? {};
	if (where.status === FundDistributionStatus.Submitted) return 'submitted';
	if (where.transactionId !== null && where.transactionId !== undefined) return 'in-flight';
	if (where.priority === FundDistributionPriority.Critical) return 'critical';
	if (where.priority === FundDistributionPriority.Warning) return 'expired';
	throw new Error(`Unrouted fundDistributionRequest.findMany: ${JSON.stringify(args?.where)}`);
}

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
		hotWallet: {
			findMany: mockHotWalletFindMany,
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

jest.unstable_mockModule('@/services/shared/chain-tx-lookup', () => ({
	lookupChainTx: mockLookupChainTx,
}));

jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONFIG: { WALLET_LOCK_TIMEOUT_INTERVAL: 300_000 },
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
		triggerFundDistributionConfirmed: mockTriggerConfirmed,
		triggerFundDistributionFailed: mockTriggerFailed,
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
	for (const key of Object.keys(phaseRows) as Phase[]) phaseRows[key] = [];

	mockGetFundWalletForPaymentSource.mockResolvedValue(fundWallet);
	mockLoadFundWalletContext.mockResolvedValue(fundWallet);
	mockRequestFindFirst.mockResolvedValue(null);
	mockRequestCreate.mockResolvedValue({ id: 'req-1' });
	mockRequestFindMany.mockImplementation(async (args: any) => phaseRows[routeFindMany(args)]);
	mockRequestUpdateMany.mockResolvedValue({ count: 0 });
	// The funded-source lookup (type: Funding) vs the low-balance scan.
	mockHotWalletFindMany.mockImplementation(async (args: any) =>
		args?.where?.type === HotWalletType.Funding ? [{ paymentSourceId: 'ps-1' }] : [],
	);
	// MUST be stubbed. Left returning undefined, `if (!targetWallet) return;`
	// short-circuits the critical dispatch path and every test below passes
	// while proving nothing about it.
	mockHotWalletFindUnique.mockResolvedValue({ walletAddress: 'addr_target' });
	mockHotWalletUpdateMany.mockResolvedValue({ count: 1 });
	mockLookupChainTx.mockResolvedValue('found');
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

	it('dispatches a critical topup immediately, to the right address and amount', async () => {
		mockRequestFindFirst
			// dedupe check inside the create transaction: nothing in flight
			.mockResolvedValueOnce(null)
			// the just-created row, re-read for immediate dispatch. The amount is
			// DELIBERATELY different from config.topupAmount (20 ADA): the dispatch
			// must send what the row says, not re-derive it from config. Identical
			// fixtures would let that confusion pass.
			.mockResolvedValueOnce({ id: 'req-1', amount: 7_000_000n });
		mockHotWalletFindUnique.mockResolvedValue({ walletAddress: 'addr_target_w1' });

		await new FundDistributionService().requestTopup({
			targetWalletId: 'w1',
			currentBalance: 4_000_000n,
			paymentSourceId: 'ps-1',
		});

		// Critical means "send now", not "wait for the batch window". Asserts the
		// routing too: right recipient, right amount.
		expect(mockProcessRequests).toHaveBeenCalledWith(fundWallet, [
			{ id: 'req-1', targetWalletId: 'w1', targetAddress: 'addr_target_w1', amount: 7_000_000n },
		]);
	});

	it('does not dispatch a warning topup immediately', async () => {
		await new FundDistributionService().requestTopup({
			targetWalletId: 'w1',
			currentBalance: 8_000_000n,
			paymentSourceId: 'ps-1',
		});

		// Warning topups wait for the batch window so they can be combined.
		expect(mockProcessRequests).not.toHaveBeenCalled();
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

	it('does not queue OR dispatch a second request while one is in flight', async () => {
		mockRequestFindFirst.mockResolvedValue({ id: 'existing' });

		await new FundDistributionService().requestTopup({
			targetWalletId: 'w1',
			currentBalance: 4_000_000n,
			paymentSourceId: 'ps-1',
		});

		// Asserting only "didn't create" is not enough: without the `if (!created)
		// return`, execution falls through to the critical dispatch and re-sends a
		// topup that is already in flight — a treasury double-spend that a
		// create-only assertion sails straight past.
		expect(mockProcessRequests).not.toHaveBeenCalled();
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
	const inFlight = (transaction: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
		id: 'req-1',
		batchId: 'batch-1',
		transactionId: 'tx-1',
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

		await new FundDistributionService().processDistributionCycle();

		expect(mockRequestUpdateMany).toHaveBeenCalledWith({
			where: { id: { in: ['req-1'] }, status: FundDistributionStatus.Pending },
			data: { status: FundDistributionStatus.Submitted, txHash: 'abc' },
		});
	});

	it('releases a rolled-back batch so it can be rebuilt', async () => {
		// TTL provably elapsed: the body can never land, so a fresh build with new
		// inputs is safe.
		phaseRows['in-flight'] = [inFlight({ status: TransactionStatus.RolledBack })];

		await new FundDistributionService().processDistributionCycle();

		expect(mockRequestUpdateMany).toHaveBeenCalledWith({
			where: { id: { in: ['req-1'] }, status: FundDistributionStatus.Pending },
			data: { transactionId: null, batchId: null },
		});
	});

	it('releases a RolledBack batch even when it still carries a txHash', async () => {
		// tx-sync marks a Transaction RolledBack BY txHash and leaves the hash set.
		// Checking txHash first would promote a batch the chain already discarded,
		// stranding it until the 30min confirm timeout for no reason.
		phaseRows['in-flight'] = [inFlight({ txHash: 'abc', status: TransactionStatus.RolledBack })];

		await new FundDistributionService().processDistributionCycle();

		expect(mockRequestUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: { transactionId: null, batchId: null } }),
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

		await new FundDistributionService().processDistributionCycle();

		expect(mockRequestUpdateMany).toHaveBeenCalledWith({
			where: { id: { in: ['req-1'] }, status: FundDistributionStatus.Pending },
			data: { transactionId: null, batchId: null },
		});
	});

	it('leaves a fresh never-broadcast row alone until the lock timeout passes', async () => {
		// It may simply still be mid build/sign.
		phaseRows['in-flight'] = [inFlight({ txHash: null, intendedTxHash: null, createdAt: new Date() })];

		await new FundDistributionService().processDistributionCycle();

		expect(mockRequestUpdateMany).not.toHaveBeenCalled();
	});

	it('leaves a signed, in-flight batch alone', async () => {
		phaseRows['in-flight'] = [inFlight({ txHash: null, intendedTxHash: 'intended-1' })];

		await new FundDistributionService().processDistributionCycle();

		expect(mockRequestUpdateMany).not.toHaveBeenCalled();
	});
});

describe('processCriticalRequests', () => {
	it('builds a batch for critical rows, routed to the right addresses', async () => {
		phaseRows.critical = [
			{
				id: 'req-1',
				fundWalletId: 'fund-1',
				targetWalletId: 'w1',
				amount: 20_000_000n,
				TargetWallet: { walletAddress: 'addr_w1' },
			},
			{
				id: 'req-2',
				fundWalletId: 'fund-1',
				targetWalletId: 'w2',
				amount: 30_000_000n,
				TargetWallet: { walletAddress: 'addr_w2' },
			},
		];

		await new FundDistributionService().processDistributionCycle();

		// Batching is the feature's whole point: both rows must reach ONE call.
		expect(mockProcessRequests).toHaveBeenCalledWith(fundWallet, [
			{ id: 'req-1', targetWalletId: 'w1', targetAddress: 'addr_w1', amount: 20_000_000n },
			{ id: 'req-2', targetWalletId: 'w2', targetAddress: 'addr_w2', amount: 30_000_000n },
		]);
	});

	it('never rebuilds a row that is already linked to an in-flight transaction', async () => {
		await new FundDistributionService().processDistributionCycle();

		// The lock is not the only thing standing between an in-flight batch and a
		// second send — wallet-timeouts can free it with no coordination — so the
		// query itself must exclude linked rows.
		expect(mockRequestFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					priority: FundDistributionPriority.Critical,
					status: FundDistributionStatus.Pending,
					transactionId: null,
				}),
			}),
		);
	});
});

describe('processExpiredBatchRequests', () => {
	const warning = (createdAt: Date) => ({
		id: 'req-1',
		fundWalletId: 'fund-1',
		targetWalletId: 'w1',
		amount: 20_000_000n,
		createdAt,
		TargetWallet: { walletAddress: 'addr_w1' },
		FundWallet: { FundDistributionConfig: { batchWindowMs: 300_000 } },
	});

	it('sends a warning batch once its window has expired', async () => {
		phaseRows.expired = [warning(new Date(Date.now() - 600_000))];

		await new FundDistributionService().processDistributionCycle();

		expect(mockProcessRequests).toHaveBeenCalledWith(fundWallet, [
			{ id: 'req-1', targetWalletId: 'w1', targetAddress: 'addr_w1', amount: 20_000_000n },
		]);
	});

	it('holds a warning batch inside its window so more topups can join it', async () => {
		phaseRows.expired = [warning(new Date())];

		await new FundDistributionService().processDistributionCycle();

		expect(mockProcessRequests).not.toHaveBeenCalled();
	});

	it('never rebuilds a row that is already linked to an in-flight transaction', async () => {
		await new FundDistributionService().processDistributionCycle();

		expect(mockRequestFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					priority: FundDistributionPriority.Warning,
					status: FundDistributionStatus.Pending,
					transactionId: null,
				}),
			}),
		);
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
		targetWalletId: 'w1',
		transactionId: 'tx-1',
		TargetWallet: { walletAddress: 'addr_target_w1' },
		FundWallet: {
			id: 'fund-1',
			walletAddress: 'addr_fund',
			lockedAt: new Date(),
			pendingTransactionId: 'tx-1',
			PaymentSource: { PaymentSourceConfig: { rpcProviderApiKey: 'key' }, network: 'Preprod' },
		},
		...overrides,
	});

	it('only looks at rows old enough for the indexer to have seen', async () => {
		phaseRows.submitted = [submitted()];

		await new FundDistributionService().processDistributionCycle();

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

	it('confirms a batch found on chain, touching only its own rows', async () => {
		phaseRows.submitted = [submitted()];
		mockLookupChainTx.mockResolvedValue('found');

		await new FundDistributionService().processDistributionCycle();

		// Assert the WHERE, not just the data: an unscoped update would mark every
		// distribution in the table Confirmed and a data-only assertion would pass.
		expect(mockRequestUpdateMany).toHaveBeenCalledWith({
			where: { id: { in: ['req-1'] }, status: FundDistributionStatus.Submitted },
			data: { status: FundDistributionStatus.Confirmed, error: null },
		});
		expect(mockTriggerConfirmed).toHaveBeenCalledWith(expect.objectContaining({ txHash: 'tx-hash-1' }));
	});

	it('fails a batch absent from chain past the timeout, touching only its own rows', async () => {
		phaseRows.submitted = [submitted({ updatedAt: new Date(Date.now() - 3_600_000) })];
		mockLookupChainTx.mockResolvedValue('not-found');

		await new FundDistributionService().processDistributionCycle();

		expect(mockRequestUpdateMany).toHaveBeenCalledWith({
			where: { id: { in: ['req-1'] }, status: FundDistributionStatus.Submitted },
			data: { status: FundDistributionStatus.Failed, error: 'Transaction not found on-chain after timeout' },
		});
		expect(mockTriggerFailed).toHaveBeenCalledWith(expect.objectContaining({ txHash: 'tx-hash-1' }));
	});

	it('keeps a not-yet-indexed batch Submitted and the wallet locked', async () => {
		phaseRows.submitted = [submitted({ updatedAt: new Date(Date.now() - 600_000) })];
		mockLookupChainTx.mockResolvedValue('not-found');

		await new FundDistributionService().processDistributionCycle();

		// Within the confirmation timeout a 404 just means Blockfrost lags.
		expect(mockTriggerFailed).not.toHaveBeenCalled();
		expect(mockHotWalletUpdateMany).not.toHaveBeenCalled();
	});

	it('does not fail or unlock a batch when the indexer is unhealthy', async () => {
		phaseRows.submitted = [submitted({ updatedAt: new Date(Date.now() - 3_600_000) })];
		mockLookupChainTx.mockResolvedValue('transient-error');

		await new FundDistributionService().processDistributionCycle();

		// Inferring "not on chain" from a 5xx is how a landed tx gets marked Failed
		// and re-sent. Even past the timeout, a transient error must not fail it.
		expect(mockRequestUpdateMany).not.toHaveBeenCalled();
		expect(mockHotWalletUpdateMany).not.toHaveBeenCalled();
	});

	it('releases only the lock held by the batch it resolved', async () => {
		phaseRows.submitted = [submitted()];
		mockLookupChainTx.mockResolvedValue('found');

		await new FundDistributionService().processDistributionCycle();

		// Clearing a lock we do not own lets the next cycle rebuild rows whose tx
		// is still in flight.
		expect(mockHotWalletUpdateMany).toHaveBeenCalledWith({
			where: { id: 'fund-1', deletedAt: null, pendingTransactionId: { in: ['tx-1'] } },
			data: { lockedAt: null, pendingTransactionId: null },
		});
	});

	it('still releases the lock when a wallet holds rows from two batches', async () => {
		// Reachable when wallet-timeouts frees the lock early and a second batch
		// takes it. Declining to unlock here would leave the wallet wedged until
		// another service happened to clean it up.
		phaseRows.submitted = [submitted(), submitted({ id: 'req-2', txHash: 'tx-hash-2', transactionId: 'tx-2' })];
		mockLookupChainTx.mockResolvedValue('found');

		await new FundDistributionService().processDistributionCycle();

		expect(mockHotWalletUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ pendingTransactionId: { in: ['tx-1', 'tx-2'] } }),
			}),
		);
	});
});
