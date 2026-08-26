import { beforeEach, describe, expect, it, jest } from '@jest/globals';

type AnyMock = jest.Mock<(...args: any[]) => any>;

const mockLockFundsL2 = jest.fn() as AnyMock;
const mockSubmitResultL2 = jest.fn() as AnyMock;
const mockBatchLatestPaymentEntries = jest.fn() as AnyMock;

jest.unstable_mockModule('@/services/payment-source-types', () => ({
	web3CardanoV2: {
		lockFundsL2: mockLockFundsL2,
		submitResultL2: mockSubmitResultL2,
		collectL2: jest.fn(async () => undefined),
		authorizeRefundL2: jest.fn(async () => undefined),
		collectRefundL2: jest.fn(async () => undefined),
		requestRefundL2: jest.fn(async () => undefined),
		authorizeWithdrawalL2: jest.fn(async () => undefined),
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

	// The reason a purchase could sit still while its head was open and idle. A
	// pass reads each wallet once, near its start; the wallet frees a moment later
	// when the lock it was holding is confirmed. Dropping the nudge that reports
	// that left the waiting purchase for the next timer tick.
	it('runs again for a nudge that arrived mid-pass', async () => {
		let releasePass: () => void = () => undefined;
		mockLockFundsL2.mockReturnValueOnce(
			new Promise<void>((resolve) => {
				releasePass = resolve;
			}),
		);

		nudgeHydraCycle('lockFunds');
		expect(mockLockFundsL2).toHaveBeenCalledTimes(1);

		// Arrives while the pass is still scanning, so that pass cannot have seen it.
		nudgeHydraCycle('lockFunds');
		expect(mockLockFundsL2).toHaveBeenCalledTimes(1);

		// Far enough past the rate-limit window that the re-run starts immediately.
		jest.spyOn(Date, 'now').mockReturnValue(clock + 60_000);
		releasePass();
		await new Promise((resolve) => setImmediate(resolve));

		expect(mockLockFundsL2).toHaveBeenCalledTimes(2);
	});

	// The caller has already committed its own work durably, and the scheduled
	// tick remains the backstop, so a failing pass must never reach the request.
	it('never throws at the caller', async () => {
		mockLockFundsL2.mockRejectedValue(new Error('head unreachable'));

		expect(() => nudgeHydraCycle('lockFunds')).not.toThrow();
		await Promise.resolve();
	});
});
