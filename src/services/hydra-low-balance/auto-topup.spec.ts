import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindMany = jest.fn() as AnyMock;
const mockCount = jest.fn() as AnyMock;
const mockExecuteHydraTopup = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraLowBalanceRule: { findMany: mockFindMany },
		hydraTopup: { count: mockCount },
	},
}));

jest.unstable_mockModule('@/services/hydra-topup/execute', () => ({
	executeHydraTopup: mockExecuteHydraTopup,
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

let runHydraAutoTopupCycle: typeof import('./auto-topup').runHydraAutoTopupCycle;

beforeAll(async () => {
	({ runHydraAutoTopupCycle } = await import('./auto-topup'));
});

function rule(overrides: Record<string, unknown> = {}) {
	return {
		id: 'rule-1',
		hydraLocalParticipantId: 'participant-1',
		assetUnit: 'lovelace',
		topupAmount: 100_000_000n,
		status: 'Low',
		LocalParticipant: { id: 'participant-1', HydraHead: { id: 'head-1', status: 'Open' } },
		...overrides,
	};
}

beforeEach(() => {
	jest.clearAllMocks();
	mockCount.mockResolvedValue(0);
	mockExecuteHydraTopup.mockResolvedValue({ topupId: 't1', depositTxHash: 'a'.repeat(64) });
});

describe('runHydraAutoTopupCycle', () => {
	it('tops up a Low rule from its participant wallet, bounded to topupAmount', async () => {
		mockFindMany.mockResolvedValue([rule()]);

		await runHydraAutoTopupCycle();

		expect(mockExecuteHydraTopup).toHaveBeenCalledWith({
			headId: 'head-1',
			filter: 'all',
			target: { unit: 'lovelace', amount: 100_000_000n },
		});
	});

	it('uses a token unit filter for a token rule', async () => {
		const unit = 'cc'.repeat(28) + '0014df10';
		mockFindMany.mockResolvedValue([rule({ assetUnit: unit, topupAmount: 500n })]);

		await runHydraAutoTopupCycle();

		expect(mockExecuteHydraTopup).toHaveBeenCalledWith({
			headId: 'head-1',
			filter: { unit },
			target: { unit, amount: 500n },
		});
	});

	it('skips when a top-up is already pending for the participant', async () => {
		mockFindMany.mockResolvedValue([rule()]);
		mockCount.mockResolvedValue(1);

		await runHydraAutoTopupCycle();

		expect(mockExecuteHydraTopup).not.toHaveBeenCalled();
	});

	it('skips when the head is not open', async () => {
		mockFindMany.mockResolvedValue([
			rule({ LocalParticipant: { id: 'participant-1', HydraHead: { id: 'head-1', status: 'Closed' } } }),
		]);

		await runHydraAutoTopupCycle();

		expect(mockExecuteHydraTopup).not.toHaveBeenCalled();
	});

	it('skips a rule with no positive topupAmount', async () => {
		mockFindMany.mockResolvedValue([rule({ topupAmount: null })]);

		await runHydraAutoTopupCycle();

		expect(mockExecuteHydraTopup).not.toHaveBeenCalled();
	});

	it('continues past a failing rule without throwing', async () => {
		mockFindMany.mockResolvedValue([rule({ id: 'rule-1' }), rule({ id: 'rule-2' })]);
		mockExecuteHydraTopup.mockRejectedValueOnce(new Error('node down'));

		await expect(runHydraAutoTopupCycle()).resolves.toBeUndefined();
		expect(mockExecuteHydraTopup).toHaveBeenCalledTimes(2);
	});
});
