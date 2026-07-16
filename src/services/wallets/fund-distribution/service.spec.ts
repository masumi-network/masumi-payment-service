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
const mockFetchTxInfo = jest.fn() as AnyMock;
const mockTriggerConfirmed = jest.fn() as AnyMock;
const mockTriggerFailed = jest.fn() as AnyMock;

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

jest.unstable_mockModule('@/services/shared/provider-factory', () => ({
	createMeshProvider: async () => ({ fetchTxInfo: mockFetchTxInfo }),
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
	mockGetFundWalletForPaymentSource.mockResolvedValue(fundWallet);
	mockLoadFundWalletContext.mockResolvedValue(fundWallet);
	mockRequestFindFirst.mockResolvedValue(null);
	mockRequestCreate.mockResolvedValue({ id: 'req-1' });
	mockRequestFindMany.mockResolvedValue([]);
	mockRequestUpdateMany.mockResolvedValue({ count: 0 });
	mockHotWalletFindMany.mockResolvedValue([]);
	// MUST be stubbed. Left returning undefined, `if (!targetWallet) return;`
	// short-circuits the critical dispatch path and every test below passes
	// while proving nothing about it.
	mockHotWalletFindUnique.mockResolvedValue({ walletAddress: 'addr_target' });
	mockHotWalletUpdateMany.mockResolvedValue({ count: 1 });
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
			// the just-created row, re-read for immediate dispatch
			.mockResolvedValueOnce({ id: 'req-1', amount: 20_000_000n });
		mockHotWalletFindUnique.mockResolvedValue({ walletAddress: 'addr_target_w1' });

		await new FundDistributionService().requestTopup({
			targetWalletId: 'w1',
			currentBalance: 4_000_000n,
			paymentSourceId: 'ps-1',
		});

		// Critical means "send now", not "wait for the batch window". Asserts the
		// routing too: right recipient, right amount.
		expect(mockProcessRequests).toHaveBeenCalledWith(fundWallet, [
			{ id: 'req-1', targetWalletId: 'w1', targetAddress: 'addr_target_w1', amount: 20_000_000n },
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

	it('only ever touches Pending rows, so a concurrently-resolved row is not resurrected', async () => {
		mockRequestFindMany.mockImplementation(async (args: any) => {
			if (args?.where?.transactionId?.not === null) {
				return [inFlight({ Transaction: { txHash: 'abc', status: TransactionStatus.Pending } })];
			}
			return [];
		});

		await new FundDistributionService().processDistributionCycle();

		// The where-clause is the guard, so assert it rather than only `data`.
		expect(mockRequestUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: { in: ['req-1'] }, status: FundDistributionStatus.Pending },
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

	const withSubmitted = (rows: unknown[]) => {
		mockHotWalletFindMany.mockImplementation(async (args: any) =>
			args?.where?.type === HotWalletType.Funding ? [{ paymentSourceId: 'ps-1' }] : [],
		);
		mockRequestFindMany.mockImplementation(async (args: any) => {
			if (args?.where?.status === FundDistributionStatus.Submitted) return rows;
			return [];
		});
	};

	it('confirms a batch found on chain and reports it', async () => {
		withSubmitted([submitted()]);
		mockFetchTxInfo.mockResolvedValue({ hash: 'tx-hash-1' });

		await new FundDistributionService().processDistributionCycle();

		expect(mockRequestUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: { status: FundDistributionStatus.Confirmed, error: null } }),
		);
		expect(mockTriggerConfirmed).toHaveBeenCalledWith(expect.objectContaining({ txHash: 'tx-hash-1' }));
	});

	it('fails a batch that is still absent from chain past the timeout, and reports it', async () => {
		// Blockfrost signals not-found by THROWING a 404, not by returning null.
		// If this branch is ever gated on a falsy return it becomes unreachable:
		// the batch never fails, the FAILED webhook never fires, and the wallet
		// stays locked forever.
		withSubmitted([submitted({ updatedAt: new Date(Date.now() - 3_600_000) })]);
		mockFetchTxInfo.mockRejectedValue(new Error('Request failed with status code 404'));

		await new FundDistributionService().processDistributionCycle();

		expect(mockRequestUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: FundDistributionStatus.Failed }),
			}),
		);
		expect(mockTriggerFailed).toHaveBeenCalledWith(expect.objectContaining({ txHash: 'tx-hash-1' }));
	});

	it('keeps a not-yet-indexed batch Submitted and the wallet locked', async () => {
		withSubmitted([submitted({ updatedAt: new Date(Date.now() - 600_000) })]);
		mockFetchTxInfo.mockRejectedValue(new Error('Request failed with status code 404'));

		await new FundDistributionService().processDistributionCycle();

		// Within the confirmation timeout a 404 just means Blockfrost lags.
		expect(mockTriggerFailed).not.toHaveBeenCalled();
		expect(mockHotWalletUpdateMany).not.toHaveBeenCalled();
	});

	it('does not fail a batch when the indexer is unhealthy', async () => {
		withSubmitted([submitted({ updatedAt: new Date(Date.now() - 3_600_000) })]);
		mockFetchTxInfo.mockRejectedValue(new Error('Request failed with status code 502'));

		await new FundDistributionService().processDistributionCycle();

		// Inferring "not on chain" from a 5xx is how a landed tx gets marked
		// Failed and re-sent. Even past the timeout, a 502 must not fail it.
		expect(mockRequestUpdateMany).not.toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: FundDistributionStatus.Failed }) }),
		);
		expect(mockHotWalletUpdateMany).not.toHaveBeenCalled();
	});

	it('releases only its own lock, guarded on the batch transaction', async () => {
		withSubmitted([submitted()]);
		mockFetchTxInfo.mockResolvedValue({ hash: 'tx-hash-1' });

		await new FundDistributionService().processDistributionCycle();

		// An unguarded unlock can clear a NEWER batch's lock, letting the next
		// cycle rebuild rows whose tx is still in flight.
		expect(mockHotWalletUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: 'fund-1', deletedAt: null, pendingTransactionId: 'tx-1' },
				data: { lockedAt: null, pendingTransactionId: null },
			}),
		);
	});
});
