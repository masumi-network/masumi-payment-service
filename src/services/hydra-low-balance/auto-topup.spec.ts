import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindMany = jest.fn() as AnyMock;
const mockCount = jest.fn() as AnyMock;
const mockExecuteHydraTopup = jest.fn() as AnyMock;
const mockLoggerWarn = jest.fn() as AnyMock;
const mockLoggerError = jest.fn() as AnyMock;
const mockGetOwnInHeadBalance = jest.fn() as AnyMock;

const mockIsHydraHeadOnPausedHost = jest.fn() as AnyMock;
const mockUnburnedUnits = new Set<string>();
let isReplayCurrent = true;

jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({
		getNode: () => ({
			l2MintCheck: isReplayCurrent ? { unburnedUnits: mockUnburnedUnits, verifiedOutputs: new Map() } : undefined,
		}),
	}),
}));

jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-head-balance', () => ({
	getOwnInHeadBalance: mockGetOwnInHeadBalance,
}));

jest.unstable_mockModule('@/services/hydra-host/pause', () => ({
	isHydraHeadOnPausedHost: mockIsHydraHeadOnPausedHost,
}));

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
	logger: { info: jest.fn(), warn: mockLoggerWarn, error: mockLoggerError, debug: jest.fn() },
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
		thresholdAmount: 50_000_000n,
		status: 'Low',
		LocalParticipant: { id: 'participant-1', HydraHead: { id: 'head-1', status: 'Open' } },
		...overrides,
	};
}

beforeEach(() => {
	jest.clearAllMocks();
	mockUnburnedUnits.clear();
	isReplayCurrent = true;
	mockGetOwnInHeadBalance.mockResolvedValue({ connected: true, l2MintChecked: true, spendableBalance: [] });
	mockCount.mockResolvedValue([]);
	mockIsHydraHeadOnPausedHost.mockResolvedValue(false);
	mockExecuteHydraTopup.mockResolvedValue({ topupId: 't1', depositTxHash: 'a'.repeat(64) });
});

describe('runHydraAutoTopupCycle', () => {
	it('sends no deposit to a head whose Host is paused', async () => {
		mockFindMany.mockResolvedValue([rule()]);
		mockIsHydraHeadOnPausedHost.mockResolvedValue(true);

		await runHydraAutoTopupCycle();

		expect(mockExecuteHydraTopup).not.toHaveBeenCalled();
	});

	// Hydra commits WHOLE UTxOs, so a bounded selection chooses which ones and
	// nothing more — it cannot bound the overshoot. The smallest single UTxO
	// covering a 100 ADA rule is the wallet's entire balance whenever its change
	// has consolidated into one output, and that whole balance then sits in the
	// head, recoverable only by a decommit or a close. An exact carve is the only
	// form of this that is bounded, so the unattended path takes it.
	it('carves the exact rule amount rather than committing whole UTxOs', async () => {
		mockFindMany.mockResolvedValue([rule()]);

		await runHydraAutoTopupCycle();

		expect(mockExecuteHydraTopup).toHaveBeenCalledWith({
			headId: 'head-1',
			filter: 'ada-only',
			exact: { unit: 'lovelace', amount: 100_000_000n },
		});
	});

	// A token rule carves too, for the same reason plus one more: the smallest
	// UTxO covering the amount is routinely one that also carries the agent's
	// registry NFT. A carve pays the token into its own output and leaves every
	// other asset behind in the change.
	it('carves a token rule to its exact amount', async () => {
		const unit = 'cc'.repeat(28) + '0014df10';
		mockFindMany.mockResolvedValue([rule({ assetUnit: unit, topupAmount: 500n })]);

		await runHydraAutoTopupCycle();

		expect(mockExecuteHydraTopup).toHaveBeenCalledWith({
			headId: 'head-1',
			filter: { unit, exclusive: true },
			exact: { unit, amount: 500n },
		});
	});

	// A deposit of a unit with a positive net L2 mint never counts as spendable,
	// so the rule would stay Low and every cycle would deposit more of it.
	it('sends no deposit of a unit that has a positive net L2 mint in the head', async () => {
		const unit = 'cc'.repeat(28) + '0014df10';
		mockUnburnedUnits.add(unit);
		mockFindMany.mockResolvedValue([rule({ assetUnit: unit.toUpperCase(), topupAmount: 500n })]);

		await runHydraAutoTopupCycle();

		expect(mockExecuteHydraTopup).not.toHaveBeenCalled();
	});

	// A peer mint of one unit must not stop the ADA top-ups the stranded ADA makes necessary.
	it('still tops up ADA while a different unit has a positive net L2 mint', async () => {
		mockUnburnedUnits.add('cc'.repeat(28) + '0014df10');
		mockFindMany.mockResolvedValue([rule()]);

		await runHydraAutoTopupCycle();

		expect(mockExecuteHydraTopup).toHaveBeenCalledTimes(1);
	});

	// The replay can turn current while the cycle reads the head. The unit check
	// must not have been skipped in that case: it would deposit a minted unit.
	it('sends no deposit and reads nothing from the head while the history replay is not current', async () => {
		const unit = 'cc'.repeat(28) + '0014df10';
		isReplayCurrent = false;
		mockUnburnedUnits.add(unit);
		mockFindMany.mockResolvedValue([rule({ assetUnit: unit, topupAmount: 500n })]);

		await runHydraAutoTopupCycle();

		expect(mockGetOwnInHeadBalance).not.toHaveBeenCalled();
		expect(mockExecuteHydraTopup).not.toHaveBeenCalled();
		expect(mockLoggerError).not.toHaveBeenCalled();
	});

	// A reconnect between the replay check and the balance read.
	it('sends no deposit when the reading right before it is not checked or not connected', async () => {
		mockFindMany.mockResolvedValue([rule()]);
		mockGetOwnInHeadBalance.mockResolvedValueOnce({ connected: true, l2MintChecked: false, spendableBalance: [] });
		await runHydraAutoTopupCycle();
		// Defense in depth: the balance service pairs connected false with l2MintChecked false.
		mockGetOwnInHeadBalance.mockResolvedValueOnce({ connected: false, l2MintChecked: true, spendableBalance: [] });
		await runHydraAutoTopupCycle();

		expect(mockGetOwnInHeadBalance).toHaveBeenCalledTimes(2);
		expect(mockExecuteHydraTopup).not.toHaveBeenCalled();
		expect(mockLoggerError).not.toHaveBeenCalled();
	});

	// A rule held Low through a reconnect, or one whose last deposit was
	// absorbed after the monitor's last cycle, already has the funds.
	it('sends no deposit when the spendable balance already covers the threshold', async () => {
		mockGetOwnInHeadBalance.mockResolvedValue({
			connected: true,
			l2MintChecked: true,
			spendableBalance: [{ unit: '', quantity: '50000000' }],
		});
		mockFindMany.mockResolvedValue([rule()]);

		await runHydraAutoTopupCycle();

		expect(mockExecuteHydraTopup).not.toHaveBeenCalled();
		expect(mockLoggerError).not.toHaveBeenCalled();
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

	// The replay can stay down as long as the deposit stays stuck; the warning
	// is the only sign of the stuck deposit.
	it('still says so about a stalled deposit while the history replay is not current', async () => {
		isReplayCurrent = false;
		mockFindMany.mockResolvedValue([rule()]);
		mockCount.mockResolvedValue([
			{
				id: 'topup-2',
				status: 'Confirmed',
				createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
				depositTxHash: 'bb'.repeat(32),
			},
		]);

		await runHydraAutoTopupCycle();

		expect(mockLoggerWarn).toHaveBeenCalledWith(
			expect.stringContaining('in flight too long'),
			expect.objectContaining({ topupId: 'topup-2' }),
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

	// Every cycle would otherwise be refused and logged as an error until the
	// close finishes.
	it('skips an open head whose close is in progress', async () => {
		mockFindMany.mockResolvedValue([
			rule({
				LocalParticipant: { id: 'participant-1', HydraHead: { id: 'head-1', status: 'Open', isClosing: true } },
			}),
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
	// A failed top-up leaves nothing in flight, so the in-flight check above is no
	// brake at all: the same attempt was made every thirty seconds for as long as
	// the rule stayed Low, writing a HydraTopup and a HydraHeadError each time and
	// burying a genuinely stranded deposit's Recover button under them.
	it('holds off after a failure instead of retrying on the next cycle', async () => {
		mockFindMany.mockResolvedValue([rule()]);
		mockCount
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ status: 'Failed', createdAt: new Date(Date.now() - 60_000) }]);

		await runHydraAutoTopupCycle();

		expect(mockExecuteHydraTopup).not.toHaveBeenCalled();
	});

	it('tries again once the wait has passed', async () => {
		mockFindMany.mockResolvedValue([rule()]);
		mockCount
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([{ status: 'Failed', createdAt: new Date(Date.now() - 6 * 60_000) }]);

		await runHydraAutoTopupCycle();

		expect(mockExecuteHydraTopup).toHaveBeenCalledTimes(1);
	});

	it('does not hold off when the last attempt settled', async () => {
		mockFindMany.mockResolvedValue([rule()]);
		mockCount.mockResolvedValueOnce([]).mockResolvedValueOnce([
			{ status: 'Absorbed', createdAt: new Date(Date.now() - 10_000) },
			{ status: 'Failed', createdAt: new Date(Date.now() - 60_000) },
		]);

		await runHydraAutoTopupCycle();

		expect(mockExecuteHydraTopup).toHaveBeenCalledTimes(1);
	});
});
