import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindMany = jest.fn() as AnyMock;
const mockCount = jest.fn() as AnyMock;
const mockExecuteHydraTopup = jest.fn() as AnyMock;
const mockLoggerWarn = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraLowBalanceRule: { findMany: mockFindMany },
		hydraTopup: { findMany: mockCount },
	},
}));

jest.unstable_mockModule('@/services/hydra-topup/execute', () => ({
	executeHydraTopup: mockExecuteHydraTopup,
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: mockLoggerWarn, error: jest.fn(), debug: jest.fn() },
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
	mockCount.mockResolvedValue([]);
	mockExecuteHydraTopup.mockResolvedValue({ topupId: 't1', depositTxHash: 'a'.repeat(64) });
});

describe('runHydraAutoTopupCycle', () => {
	// An automatic rule runs unattended and commits WHOLE UTxOs — no exact-amount
	// carve on this path — and the selector takes the smallest single UTxO that
	// covers the target. Under `all` that is routinely ordinary change carrying a
	// native asset, so an ADA top-up would sweep an agent's registry NFT into the
	// head, recoverable only by a decommit or a close.
	it('tops up a Low rule from pure-ADA UTxOs only, bounded to topupAmount', async () => {
		mockFindMany.mockResolvedValue([rule()]);

		await runHydraAutoTopupCycle();

		expect(mockExecuteHydraTopup).toHaveBeenCalledWith({
			headId: 'head-1',
			filter: 'ada-only',
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
		mockCount.mockResolvedValue([{ id: 'topup-1', status: 'Pending', createdAt: new Date(), depositTxHash: null }]);

		await runHydraAutoTopupCycle();

		expect(mockExecuteHydraTopup).not.toHaveBeenCalled();
		expect(mockLoggerWarn).not.toHaveBeenCalled();
	});

	// A deposit the head never picks up leaves its row `Confirmed` for good, and
	// that row disables auto top-up for the participant from then on. The rule
	// stays Low and the low-balance webhook fires only on the Healthy -> Low
	// edge, so without this the failure is completely silent.
	//
	// `updatedAt` is deliberately fresh here: the reconciler rotates it to now on
	// every tick it cannot resolve the deposit, so ageing off it would silence
	// this warning for the one row it exists for.
	it('says so when the deposit blocking it has been in flight for an hour', async () => {
		mockFindMany.mockResolvedValue([rule()]);
		mockCount.mockResolvedValue([
			{
				id: 'topup-1',
				status: 'Confirmed',
				createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
				depositTxHash: 'aa'.repeat(32),
			},
		]);

		await runHydraAutoTopupCycle();

		expect(mockExecuteHydraTopup).not.toHaveBeenCalled();
		expect(mockLoggerWarn).toHaveBeenCalledWith(
			expect.stringContaining('in flight too long'),
			expect.objectContaining({ topupId: 'topup-1' }),
		);
	});

	// A deposit that has confirmed on chain has not reached the head: the node
	// leaves it alone for a whole deposit period first, and the rule stays Low
	// for all of it. Counting only `Pending` made that window look idle and sent
	// a fresh deposit every cycle.
	it('counts a confirmed but unabsorbed deposit as in flight', async () => {
		mockFindMany.mockResolvedValue([rule()]);
		mockCount.mockResolvedValue([]);

		await runHydraAutoTopupCycle();

		expect(mockCount).toHaveBeenCalledWith({
			where: {
				hydraLocalParticipantId: 'participant-1',
				status: { in: ['Preparing', 'Pending', 'Confirmed'] },
			},
			select: { id: true, status: true, createdAt: true, depositTxHash: true },
			orderBy: { createdAt: 'asc' },
		});
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
