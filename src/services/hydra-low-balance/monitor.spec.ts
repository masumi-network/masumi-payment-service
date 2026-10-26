import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindMany = jest.fn() as AnyMock;
const mockUpdate = jest.fn() as AnyMock;
const mockUpdateMany = jest.fn() as AnyMock;
const mockTransaction = jest.fn() as AnyMock;
const mockGetOwnInHeadBalance = jest.fn() as AnyMock;
const mockQueueHydraHeadLowBalance = jest.fn() as AnyMock;

const transactionClient = {
	hydraLowBalanceRule: { updateMany: mockUpdateMany },
};

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraLowBalanceRule: { findMany: mockFindMany, update: mockUpdate, updateMany: mockUpdateMany },
		$transaction: mockTransaction,
	},
}));

jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-head-balance', () => ({
	getOwnInHeadBalance: mockGetOwnInHeadBalance,
}));

jest.unstable_mockModule('@/services/webhooks/events.service', () => ({
	webhookEventsService: { queueHydraHeadLowBalanceInTransaction: mockQueueHydraHeadLowBalance },
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

let evaluateHydraLowBalanceRules: typeof import('./monitor').evaluateHydraLowBalanceRules;
let runHydraLowBalanceMonitoringCycle: typeof import('./monitor').runHydraLowBalanceMonitoringCycle;

beforeAll(async () => {
	({ evaluateHydraLowBalanceRules, runHydraLowBalanceMonitoringCycle } = await import('./monitor'));
});

function rule(overrides: Record<string, unknown> = {}) {
	return {
		id: 'rule-1',
		hydraLocalParticipantId: 'participant-1',
		assetUnit: 'lovelace',
		thresholdAmount: 50_000_000n,
		status: 'Healthy',
		LocalParticipant: { id: 'participant-1', HydraHead: { id: 'head-1', status: 'Open' } },
		...overrides,
	};
}

function balance(quantity: string, unit = '', spendableQuantity = quantity) {
	return {
		hydraHeadId: 'head-1',
		address: 'addr',
		connected: true,
		utxoCount: 1,
		l2MintChecked: true,
		balance: [{ unit, quantity }],
		spendableBalance: [{ unit, quantity: spendableQuantity }],
	};
}

beforeEach(() => {
	jest.clearAllMocks();
	mockUpdate.mockResolvedValue({});
	mockUpdateMany.mockResolvedValue({ count: 1 });
	mockTransaction.mockImplementation(async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
		callback(transactionClient),
	);
});

describe('evaluateHydraLowBalanceRules', () => {
	it('alerts once when the in-head balance transitions below threshold', async () => {
		mockFindMany.mockResolvedValue([rule()]);
		mockGetOwnInHeadBalance.mockResolvedValue(balance('10000000'));

		const alerts = await evaluateHydraLowBalanceRules();

		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toMatchObject({ ruleId: 'rule-1', hydraHeadId: 'head-1', currentAmount: 10_000_000n });
		// Won by the edge OR by the age of the last alert. Edge alone made the
		// webhook unrecoverable when anything failed between this write and the
		// queueing that follows it: every later cycle found the row already Low,
		// took the refresh branch, and nobody was ever told.
		const where = mockUpdateMany.mock.calls[0]?.[0]?.where as {
			id: string;
			OR: Array<Record<string, unknown>>;
		};
		expect(where.id).toBe('rule-1');
		expect(where.OR).toEqual([
			{ status: { not: 'Low' } },
			{ lastAlertedAt: null },
			{ lastAlertedAt: { lt: expect.any(Date) } },
		]);
	});

	it('alerts again once a rule has been Low without an alert for long enough', async () => {
		mockFindMany.mockResolvedValue([rule()]);
		mockGetOwnInHeadBalance.mockResolvedValue(balance('10000000'));
		mockUpdateMany.mockResolvedValue({ count: 1 });

		const alerts = await evaluateHydraLowBalanceRules();

		// The write is what decides; a rule already Low whose `lastAlertedAt` is
		// older than the interval matches it, so the alert is emitted again.
		expect(alerts).toHaveLength(1);
	});

	it('does not re-alert when the rule is already Low (atomic guard misses)', async () => {
		mockFindMany.mockResolvedValue([rule()]);
		mockGetOwnInHeadBalance.mockResolvedValue(balance('10000000'));
		mockUpdateMany.mockResolvedValue({ count: 0 });

		const alerts = await evaluateHydraLowBalanceRules();

		expect(alerts).toHaveLength(0);
		expect(mockUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: 'rule-1' },
				data: expect.objectContaining({ lastKnownAmount: 10_000_000n }),
			}),
		);
	});

	it('marks Healthy and does not alert when balance is at/above threshold', async () => {
		mockFindMany.mockResolvedValue([rule()]);
		mockGetOwnInHeadBalance.mockResolvedValue(balance('60000000'));

		const alerts = await evaluateHydraLowBalanceRules();

		expect(alerts).toHaveLength(0);
		expect(mockUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: 'Healthy' }) }),
		);
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	it('skips a rule whose head is not Open (balance unknown, never a false alert)', async () => {
		mockFindMany.mockResolvedValue([
			rule({ LocalParticipant: { id: 'participant-1', HydraHead: { id: 'head-1', status: 'Closed' } } }),
		]);

		const alerts = await evaluateHydraLowBalanceRules();

		expect(alerts).toHaveLength(0);
		expect(mockGetOwnInHeadBalance).not.toHaveBeenCalled();
	});

	it('skips a rule whose head has no live snapshot', async () => {
		mockFindMany.mockResolvedValue([rule()]);
		mockGetOwnInHeadBalance.mockResolvedValue({ ...balance('0'), connected: false });

		const alerts = await evaluateHydraLowBalanceRules();

		expect(alerts).toHaveLength(0);
		expect(mockUpdate).not.toHaveBeenCalled();
	});

	// An unchecked reading can count funds the service will not spend. A rule set
	// Healthy by it alerts again once the replay is current, on every reconnect.
	it('keeps the status on a reading the replay has not checked', async () => {
		mockFindMany.mockResolvedValue([rule({ status: 'Low' })]);
		mockGetOwnInHeadBalance.mockResolvedValue({ ...balance('60000000'), l2MintChecked: false });

		const alerts = await evaluateHydraLowBalanceRules();

		expect(alerts).toHaveLength(0);
		expect(mockUpdate).toHaveBeenCalledWith({
			where: { id: 'rule-1' },
			data: { lastKnownAmount: 60_000_000n, lastCheckedAt: expect.any(Date) },
		});
	});

	// An unchecked reading is never lower than the checked one, so it can still
	// show a rule is Low. A failed replay must not silence the alert.
	it('alerts on a reading the replay has not checked when it is below the threshold', async () => {
		mockFindMany.mockResolvedValue([rule()]);
		mockGetOwnInHeadBalance.mockResolvedValue({ ...balance('10000000'), l2MintChecked: false });

		const alerts = await evaluateHydraLowBalanceRules();

		expect(alerts).toHaveLength(1);
	});

	// ADA under an unburned L2-minted token is in the head but the service
	// never spends it. Counting it kept a head with nothing usable from alerting.
	it('compares the spendable balance, not the total the head reports', async () => {
		mockFindMany.mockResolvedValue([rule()]);
		mockGetOwnInHeadBalance.mockResolvedValue(balance('60000000', '', '10000000'));

		const alerts = await evaluateHydraLowBalanceRules();

		expect(alerts).toHaveLength(1);
		expect(alerts[0].currentAmount).toBe(10_000_000n);
	});

	it('matches a token assetUnit and treats a missing asset as zero', async () => {
		const unit = 'aa'.repeat(28) + '0014df10';
		mockFindMany.mockResolvedValue([rule({ assetUnit: unit, thresholdAmount: 5n })]);
		mockGetOwnInHeadBalance.mockResolvedValue(balance('10000000')); // only lovelace present

		const alerts = await evaluateHydraLowBalanceRules();

		expect(alerts).toHaveLength(1);
		expect(alerts[0].currentAmount).toBe(0n);
	});
});

describe('runHydraLowBalanceMonitoringCycle', () => {
	it('queues a webhook for each transitioned rule', async () => {
		mockFindMany.mockResolvedValue([rule()]);
		mockGetOwnInHeadBalance.mockResolvedValue(balance('10000000'));

		await runHydraLowBalanceMonitoringCycle();

		expect(mockQueueHydraHeadLowBalance).toHaveBeenCalledTimes(1);
		expect(mockQueueHydraHeadLowBalance).toHaveBeenCalledWith(
			transactionClient,
			expect.objectContaining({ ruleId: 'rule-1', currentAmount: '10000000', thresholdAmount: '50000000' }),
		);
	});

	it('does not mark a low alert sent when queueing fails, so the next cycle can retry', async () => {
		let storedStatus = 'Healthy';
		let storedLastAlertedAt: Date | null = null;
		let committedDeliveries = 0;
		let stagedDeliveries = 0;
		let queueAttempts = 0;
		mockFindMany.mockImplementation(async () => [rule({ status: storedStatus, lastAlertedAt: storedLastAlertedAt })]);
		mockGetOwnInHeadBalance.mockResolvedValue(balance('10000000'));
		mockQueueHydraHeadLowBalance.mockImplementation(async () => {
			queueAttempts += 1;
			if (queueAttempts === 1) throw new Error('queue insert failed');
			stagedDeliveries += 1;
		});
		mockUpdateMany.mockImplementation(async ({ where, data }) => {
			const shouldAlert =
				storedStatus !== 'Low' || storedLastAlertedAt === null || storedLastAlertedAt < where.OR[2].lastAlertedAt.lt;
			if (!shouldAlert) return { count: 0 };
			storedStatus = data.status;
			storedLastAlertedAt = data.lastAlertedAt;
			return { count: 1 };
		});
		mockTransaction.mockImplementation(async (callback: (tx: typeof transactionClient) => Promise<unknown>) => {
			const previousStatus = storedStatus;
			const previousLastAlertedAt = storedLastAlertedAt;
			stagedDeliveries = 0;
			try {
				const result = await callback(transactionClient);
				committedDeliveries += stagedDeliveries;
				return result;
			} catch (error) {
				storedStatus = previousStatus;
				storedLastAlertedAt = previousLastAlertedAt;
				stagedDeliveries = 0;
				throw error;
			}
		});

		await expect(evaluateHydraLowBalanceRules()).resolves.toHaveLength(0);
		expect(mockTransaction).toHaveBeenCalledTimes(1);
		expect(storedStatus).toBe('Healthy');
		expect(storedLastAlertedAt).toBeNull();
		expect(committedDeliveries).toBe(0);
		await expect(evaluateHydraLowBalanceRules()).resolves.toHaveLength(1);
		expect(mockQueueHydraHeadLowBalance).toHaveBeenCalledTimes(2);
		expect(storedStatus).toBe('Low');
		expect(storedLastAlertedAt).toBeInstanceOf(Date);
		expect(committedDeliveries).toBe(1);
	});
});
