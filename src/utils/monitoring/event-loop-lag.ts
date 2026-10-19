import { logger } from '@masumi/payment-core/logger';

/** How often the probe expects to run. */
export const EVENT_LOOP_PROBE_INTERVAL_MS = 500;

/**
 * A stall at least this long is reported. The pg pool gives up on a
 * connection after 10 s (`connect_timeout`), so a stall well under that is
 * already worth hearing about before it turns into pool timeouts.
 */
export const EVENT_LOOP_STALL_THRESHOLD_MS = 1_000;

/** How long the loop was blocked, given when the probe was due and when it ran. */
export function measureEventLoopStallMs(expectedAtMs: number, ranAtMs: number): number {
	return Math.max(0, ranAtMs - expectedAtMs);
}

/**
 * Warn whenever synchronous work holds the event loop.
 *
 * A blocked loop shows up elsewhere only as unrelated-looking symptoms (every
 * queued DB connection timing out in the same millisecond, scheduler jobs
 * taking minutes), so this states the cause directly: the stall length and
 * when it ended. The timer is unref'd so it never keeps the process alive.
 */
export function startEventLoopStallMonitor(): () => void {
	let expectedAtMs = Date.now() + EVENT_LOOP_PROBE_INTERVAL_MS;
	const timer = setInterval(() => {
		const nowMs = Date.now();
		const stallMs = measureEventLoopStallMs(expectedAtMs, nowMs);
		expectedAtMs = nowMs + EVENT_LOOP_PROBE_INTERVAL_MS;
		if (stallMs >= EVENT_LOOP_STALL_THRESHOLD_MS) {
			logger.warn('[EventLoop] synchronous work blocked the event loop', { stallMs });
		}
	}, EVENT_LOOP_PROBE_INTERVAL_MS);
	timer.unref();
	return () => clearInterval(timer);
}
