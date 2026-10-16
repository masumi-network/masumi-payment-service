import { jest } from '@jest/globals';

const mockWarn = jest.fn();
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { debug: jest.fn(), info: jest.fn(), warn: mockWarn, error: jest.fn() },
}));

const { EVENT_LOOP_PROBE_INTERVAL_MS, measureEventLoopStallMs, startEventLoopStallMonitor } =
	await import('./event-loop-lag');

describe('event loop stall monitor', () => {
	beforeEach(() => {
		jest.useFakeTimers();
		mockWarn.mockClear();
	});
	afterEach(() => {
		jest.useRealTimers();
	});

	it('measures how late the probe ran, never negative', () => {
		expect(measureEventLoopStallMs(1_000, 4_500)).toBe(3_500);
		expect(measureEventLoopStallMs(1_000, 900)).toBe(0);
	});

	it('stays quiet while the loop is free', () => {
		const stop = startEventLoopStallMonitor();
		jest.advanceTimersByTime(EVENT_LOOP_PROBE_INTERVAL_MS * 10);
		stop();
		expect(mockWarn).not.toHaveBeenCalled();
	});

	it('warns with the stall length once synchronous work blocked the loop', () => {
		const stop = startEventLoopStallMonitor();
		// The clock moves 3 s while no timer may run: a blocked loop.
		jest.setSystemTime(Date.now() + 3_000);
		jest.advanceTimersByTime(EVENT_LOOP_PROBE_INTERVAL_MS);
		stop();
		expect(mockWarn).toHaveBeenCalledTimes(1);
		const [, meta] = mockWarn.mock.calls[0] as [string, { stallMs: number }];
		expect(meta.stallMs).toBeGreaterThanOrEqual(3_000);
	});
});
