import { beforeEach, describe, expect, it, jest } from '@jest/globals';

type AnyMock = jest.Mock<(...args: any[]) => any>;

const mockLockFundsL2 = jest.fn() as AnyMock;
const mockSubmitResultL2 = jest.fn() as AnyMock;
const mockBatchLatestPaymentEntries = jest.fn() as AnyMock;

jest.unstable_mockModule('@/services/payment-source-types', () => ({
	web3CardanoV2: {
		lockFundsL2: mockLockFundsL2,
		submitResultL2: mockSubmitResultL2,
		// Present so the test would notice if the nudge ever reached for the whole
		// cycle instead of the head-only pass.
		batchLatestPaymentEntries: mockBatchLatestPaymentEntries,
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { nudgeHydraCycle } = await import('./index');

let clock = 1_000_000;

beforeEach(() => {
	jest.clearAllMocks();
	// The cooldown is module state that outlives a test, so each case starts
	// beyond it rather than inheriting the previous case's timestamp.
	jest.spyOn(Date, 'now').mockReturnValue(clock);
	clock += 60_000;
	mockLockFundsL2.mockResolvedValue(undefined);
	mockSubmitResultL2.mockResolvedValue(undefined);
});

/**
 * A head lock is a signature exchange, so waiting for a batch tick is latency we
 * add rather than latency the chain imposes. Running the whole cycle early would
 * fix that by dragging the L1 batch forward too, which is a behaviour change
 * nobody asked for.
 */
describe('nudgeHydraCycle', () => {
	it('runs the head-only pass, never the full cycle', () => {
		nudgeHydraCycle('lockFunds');

		expect(mockLockFundsL2).toHaveBeenCalledTimes(1);
		expect(mockBatchLatestPaymentEntries).not.toHaveBeenCalled();
	});

	// Ten purchases in a second would otherwise queue ten identical scans, and a
	// pass already running picks up work created a moment ago anyway.
	it('collapses a burst into one pass', () => {
		nudgeHydraCycle('submitResult');
		nudgeHydraCycle('submitResult');
		nudgeHydraCycle('submitResult');

		expect(mockSubmitResultL2).toHaveBeenCalledTimes(1);
	});

	it('keeps the kinds independent', () => {
		nudgeHydraCycle('lockFunds');
		nudgeHydraCycle('submitResult');

		expect(mockLockFundsL2).toHaveBeenCalledTimes(1);
		expect(mockSubmitResultL2).toHaveBeenCalledTimes(1);
	});

	// The caller has already committed its own work durably, and the scheduled
	// tick remains the backstop, so a failing pass must never reach the request.
	it('never throws at the caller', async () => {
		mockLockFundsL2.mockRejectedValue(new Error('head unreachable'));

		expect(() => nudgeHydraCycle('lockFunds')).not.toThrow();
		await Promise.resolve();
	});
});
