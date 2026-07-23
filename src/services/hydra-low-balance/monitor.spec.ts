import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindMany = jest.fn() as AnyMock;
const mockUpdate = jest.fn() as AnyMock;
const mockUpdateMany = jest.fn() as AnyMock;
const mockGetOwnInHeadBalance = jest.fn() as AnyMock;
const mockTriggerHydraHeadLowBalance = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraLowBalanceRule: { findMany: mockFindMany, update: mockUpdate, updateMany: mockUpdateMany },
	},
}));

jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-head-balance', () => ({
	getOwnInHeadBalance: mockGetOwnInHeadBalance,
}));

jest.unstable_mockModule('@/services/webhooks/events.service', () => ({
	webhookEventsService: { triggerHydraHeadLowBalance: mockTriggerHydraHeadLowBalance },
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

function balance(quantity: string, unit = '') {
	return { hydraHeadId: 'head-1', address: 'addr', connected: true, utxoCount: 1, balance: [{ unit, quantity }] };
}

beforeEach(() => {
	jest.clearAllMocks();
	mockUpdate.mockResolvedValue({});
	mockUpdateMany.mockResolvedValue({ count: 1 });
});

describe('evaluateHydraLowBalanceRules', () => {
	it('alerts once when the in-head balance transitions below threshold', async () => {
		mockFindMany.mockResolvedValue([rule()]);
		mockGetOwnInHeadBalance.mockResolvedValue(balance('10000000'));

		const alerts = await evaluateHydraLowBalanceRules();

		expect(alerts).toHaveLength(1);
		expect(alerts[0]).toMatchObject({ ruleId: 'rule-1', hydraHeadId: 'head-1', currentAmount: 10_000_000n });
		expect(mockUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: 'rule-1', status: { not: 'Low' } } }),
		);
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
	it('emits a webhook for each transitioned rule', async () => {
		mockFindMany.mockResolvedValue([rule()]);
		mockGetOwnInHeadBalance.mockResolvedValue(balance('10000000'));

		await runHydraLowBalanceMonitoringCycle();

		expect(mockTriggerHydraHeadLowBalance).toHaveBeenCalledTimes(1);
		expect(mockTriggerHydraHeadLowBalance).toHaveBeenCalledWith(
			expect.objectContaining({ ruleId: 'rule-1', currentAmount: '10000000', thresholdAmount: '50000000' }),
		);
	});
});
