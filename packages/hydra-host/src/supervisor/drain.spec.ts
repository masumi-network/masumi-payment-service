import { describe, expect, it, jest } from '@jest/globals';
import { NodeResponseError, NodeUnreachableError } from '../errors.js';
import { drainReader, isSafeToStop, waitForDrain, type LastSeenSnapshotResponse } from './drain.js';

function clock(start = 0) {
	let current = start;
	return {
		now: () => current,
		sleep: async (ms: number) => {
			current += ms;
		},
	};
}

describe('isSafeToStop', () => {
	it('permits a stop only on a settled round', () => {
		expect(isSafeToStop({ tag: 'LastSeenSnapshot' })).toBe(true);
		expect(isSafeToStop({ tag: 'NoSeenSnapshot' })).toBe(true);
	});

	it('treats an in-flight round as unsafe', () => {
		expect(isSafeToStop({ tag: 'SeenSnapshot' })).toBe(false);
		expect(isSafeToStop({ tag: 'RequestedSnapshot' })).toBe(false);
	});

	// Fail closed: an unrecognised tag must never be read as "safe", because
	// stopping mid-round can strand the head permanently.
	it('treats unknown, missing and malformed tags as unsafe', () => {
		expect(isSafeToStop({ tag: 'SomeFutureTag' })).toBe(false);
		expect(isSafeToStop({})).toBe(false);
		expect(isSafeToStop(null)).toBe(false);
		expect(isSafeToStop(undefined)).toBe(false);
		expect(isSafeToStop({ tag: 42 })).toBe(false);
	});
});

describe('waitForDrain', () => {
	it('returns immediately when no round is in flight', async () => {
		const { now, sleep } = clock();
		const fetchLastSeen = jest.fn<() => Promise<LastSeenSnapshotResponse>>().mockResolvedValue({
			tag: 'NoSeenSnapshot',
		});

		const outcome = await waitForDrain({ fetchLastSeen, timeoutMs: 60_000, pollIntervalMs: 1_000, sleep, now });

		expect(outcome.drained).toBe(true);
		expect(outcome.waitedMs).toBe(0);
		expect(fetchLastSeen).toHaveBeenCalledTimes(1);
	});

	it('waits for an in-flight round to settle, then reports drained', async () => {
		const { now, sleep } = clock();
		const fetchLastSeen = jest
			.fn<() => Promise<LastSeenSnapshotResponse>>()
			.mockResolvedValueOnce({ tag: 'SeenSnapshot' })
			.mockResolvedValueOnce({ tag: 'SeenSnapshot' })
			.mockResolvedValue({ tag: 'LastSeenSnapshot' });

		const outcome = await waitForDrain({ fetchLastSeen, timeoutMs: 60_000, pollIntervalMs: 1_000, sleep, now });

		expect(outcome.drained).toBe(true);
		expect(outcome.waitedMs).toBe(2_000);
		expect(fetchLastSeen).toHaveBeenCalledTimes(3);
	});

	it('gives up after the timeout and reports the stop as undrained', async () => {
		const { now, sleep } = clock();
		const fetchLastSeen = jest.fn<() => Promise<LastSeenSnapshotResponse>>().mockResolvedValue({
			tag: 'SeenSnapshot',
		});

		const outcome = await waitForDrain({ fetchLastSeen, timeoutMs: 5_000, pollIntervalMs: 1_000, sleep, now });

		expect(outcome.drained).toBe(false);
		expect(outcome.lastTag).toBe('SeenSnapshot');
		expect(outcome.waitedMs).toBeGreaterThanOrEqual(5_000);
	});

	// A node that cannot be reached is already down; blocking the full timeout
	// would only delay a stop that has nothing left to protect.
	it('stops waiting when the node is unreachable', async () => {
		const { now, sleep } = clock();
		const fetchLastSeen = jest
			.fn<() => Promise<LastSeenSnapshotResponse>>()
			.mockRejectedValue(new NodeUnreachableError('ECONNREFUSED'));

		const outcome = await waitForDrain({ fetchLastSeen, timeoutMs: 60_000, pollIntervalMs: 1_000, sleep, now });

		expect(outcome.drained).toBe(true);
		// Reported separately from `drained`, because a caller that knows the
		// process is still running reads this as wedged rather than gone.
		expect(outcome.reason).toBe('unreachable');
		expect(fetchLastSeen).toHaveBeenCalledTimes(1);
	});

	// Answering badly is NOT the same as being gone: the node is live and may
	// have a round in flight, so we must not report it as drained.
	it('keeps polling when the node answers with something unusable', async () => {
		const { now, sleep } = clock();
		const fetchLastSeen = jest
			.fn<() => Promise<LastSeenSnapshotResponse>>()
			.mockRejectedValueOnce(new NodeResponseError('body is not JSON'))
			.mockResolvedValue({ tag: 'LastSeenSnapshot' });

		const outcome = await waitForDrain({ fetchLastSeen, timeoutMs: 60_000, pollIntervalMs: 1_000, sleep, now });

		expect(outcome.drained).toBe(true);
		expect(fetchLastSeen).toHaveBeenCalledTimes(2);
	});

	it('times out as undrained when the node only ever answers badly', async () => {
		const { now, sleep } = clock();
		const fetchLastSeen = jest
			.fn<() => Promise<LastSeenSnapshotResponse>>()
			.mockRejectedValue(new NodeResponseError('500'));

		const outcome = await waitForDrain({ fetchLastSeen, timeoutMs: 3_000, pollIntervalMs: 1_000, sleep, now });

		expect(outcome.drained).toBe(false);
	});
});

// The deadline is checked only after a read resolves, so an unbounded poll that
// starts just inside the budget overruns it by a whole request timeout: 130s
// against 120s, which makes the per-node stop 165s rather than the 155s the
// shutdown grace is sized from.
describe('waitForDrain read budget', () => {
	it('bounds each read by what is left of the drain budget', async () => {
		const requested: Array<number | undefined> = [];
		let clock = 0;

		await waitForDrain({
			fetchLastSeen: (timeoutMs) => {
				requested.push(timeoutMs);
				clock += 40_000;
				return Promise.resolve({ tag: 'SeenSnapshot' });
			},
			timeoutMs: 100_000,
			pollIntervalMs: 2_000,
			sleep: () => {
				clock += 2_000;
				return Promise.resolve();
			},
			now: () => clock,
		});

		expect(requested[0]).toBe(100_000);
		// Every later read is offered only the remainder, never the full budget.
		for (const [index, timeout] of requested.entries()) {
			expect(timeout).toBeLessThanOrEqual(100_000 - index * 40_000 + 1);
		}
	});

	it('stops without issuing a read once the budget is spent', async () => {
		let calls = 0;
		let clock = 0;

		const outcome = await waitForDrain({
			fetchLastSeen: () => {
				calls += 1;
				clock += 100_000;
				return Promise.resolve({ tag: 'SeenSnapshot' });
			},
			timeoutMs: 50_000,
			pollIntervalMs: 2_000,
			sleep: () => Promise.resolve(),
			now: () => clock,
		});

		expect(calls).toBe(1);
		expect(outcome).toMatchObject({ drained: false, reason: 'timeout' });
	});
});

// The bug this pins is invisible in a type-check: a zero-parameter
// `() => client.fetchLastSeen()` satisfies `DrainOptions.fetchLastSeen`, so the
// budget is computed, passed and silently dropped, and every poll falls back to
// the client's own 10s default. A drain test with its own fake cannot see it —
// it asserts against the fake, not the wiring.
describe('drainReader', () => {
	it('forwards the budget the drain computed', async () => {
		const seen: Array<number | undefined> = [];
		const read = drainReader({
			fetchLastSeen: (timeoutMs) => {
				seen.push(timeoutMs);
				return Promise.resolve({ tag: 'LastSeenSnapshot' });
			},
		});

		await read(1_234);
		await read();

		expect(seen).toEqual([1_234, undefined]);
	});

	it('is what the drain actually calls, so a dropped budget shows up here', async () => {
		const seen: Array<number | undefined> = [];
		let clock = 0;

		await waitForDrain({
			fetchLastSeen: drainReader({
				fetchLastSeen: (timeoutMs) => {
					seen.push(timeoutMs);
					clock += 30_000;
					return Promise.resolve({ tag: 'SeenSnapshot' });
				},
			}),
			timeoutMs: 60_000,
			pollIntervalMs: 2_000,
			sleep: () => {
				clock += 2_000;
				return Promise.resolve();
			},
			now: () => clock,
		});

		expect(seen[0]).toBe(60_000);
		expect(seen.every((timeoutMs) => timeoutMs !== undefined)).toBe(true);
	});
});
