import { describe, expect, it, jest } from '@jest/globals';
import { NodeResponseError, NodeUnreachableError } from '../errors.js';
import { isSafeToStop, waitForDrain, type LastSeenSnapshotResponse } from './drain.js';

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
