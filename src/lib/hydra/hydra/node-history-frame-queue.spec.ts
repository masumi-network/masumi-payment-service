import { afterEach, describe, expect, it, jest } from '@jest/globals';

import {
	HISTORY_REPLAY_QUEUE_HIGH_WATER,
	HISTORY_REPLAY_YIELD_BUDGET_MS,
	HistoryFrameQueue,
	type QueuedHistoryFrame,
} from './node-history-frame-queue';

const NO_FLOW = { pause: () => undefined, resume: () => undefined };

const flush = async () => {
	await new Promise((resolve) => setImmediate(resolve));
};

function frame(rawMessage: string, pass = 0): QueuedHistoryFrame {
	return { rawMessage, pass };
}

describe('HistoryFrameQueue', () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('works synchronous frames at once, in order', () => {
		const seen: string[] = [];
		const queue = new HistoryFrameQueue(
			({ rawMessage }) => {
				seen.push(rawMessage);
				return undefined;
			},
			() => true,
			NO_FLOW,
		);
		queue.push(frame('a'));
		queue.push(frame('b'));
		expect(seen).toEqual(['a', 'b']);
		expect(queue.size).toBe(0);
	});

	it('holds every later frame behind one that waits, then resumes in order', async () => {
		const seen: string[] = [];
		let release: () => void = () => undefined;
		const queue = new HistoryFrameQueue(
			({ rawMessage }) => {
				seen.push(rawMessage);
				if (rawMessage !== 'a') return undefined;
				return new Promise<void>((resolve) => {
					release = resolve;
				});
			},
			() => true,
			NO_FLOW,
		);
		queue.push(frame('a'));
		queue.push(frame('b'));
		queue.pushFront([frame('first')]);
		expect(seen).toEqual(['a']);

		release();
		await flush();
		expect(seen).toEqual(['a', 'first', 'b']);
	});

	it('resumes after a waiting frame whose promise rejects', async () => {
		const seen: string[] = [];
		const queue = new HistoryFrameQueue(
			({ rawMessage }) => {
				seen.push(rawMessage);
				return rawMessage === 'a' ? Promise.reject(new Error('broken contract')) : undefined;
			},
			() => true,
			NO_FLOW,
		);
		queue.push(frame('a'));
		queue.push(frame('b'));
		await flush();
		expect(seen).toEqual(['a', 'b']);
	});

	it('yields to the event loop once a slice has spent its budget', async () => {
		let clockMs = 0;
		jest.spyOn(Date, 'now').mockImplementation(() => clockMs);
		const seen: string[] = [];
		const queue = new HistoryFrameQueue(
			({ rawMessage }) => {
				seen.push(rawMessage);
				clockMs += HISTORY_REPLAY_YIELD_BUDGET_MS;
				return undefined;
			},
			() => true,
			NO_FLOW,
		);
		queue.pushFront([frame('a'), frame('b'), frame('c')]);
		expect(seen).toEqual(['a']);
		await flush();
		expect(seen).toEqual(['a', 'b']);
		await flush();
		expect(seen).toEqual(['a', 'b', 'c']);
	});

	it('drops frames that are no longer live, and everything on clear', async () => {
		let currentPass = 1;
		const seen: string[] = [];
		let release: () => void = () => undefined;
		const queue = new HistoryFrameQueue(
			({ rawMessage }) => {
				seen.push(rawMessage);
				if (rawMessage !== 'wait') return undefined;
				return new Promise<void>((resolve) => {
					release = resolve;
				});
			},
			({ pass }) => pass === currentPass,
			NO_FLOW,
		);
		queue.push(frame('stale', 0));
		queue.push(frame('wait', 1));
		queue.push(frame('queued', 1));
		queue.clear();
		currentPass = 2;
		queue.push(frame('fresh', 2));
		expect(seen).toEqual(['wait']);

		release();
		await flush();
		expect(seen).toEqual(['wait', 'fresh']);
	});

	// While frames wait on their accumulators the socket keeps delivering, and a
	// history is hundreds of megabytes of full UTxO sets: without a bound, all
	// of it sat in memory at once, per head, on every reconnect.
	it('pauses its source above the high-water mark and resumes it at half', async () => {
		const flow = { pause: jest.fn(), resume: jest.fn() };
		const releases: Array<() => void> = [];
		const queue = new HistoryFrameQueue(
			() =>
				new Promise<void>((resolve) => {
					releases.push(resolve);
				}),
			() => true,
			flow,
		);
		const quarter = 'x'.repeat(HISTORY_REPLAY_QUEUE_HIGH_WATER / 4);
		// The first frame is taken at once and waits; four more fill the queue to
		// the mark, and the fifth crosses it.
		for (let index = 0; index < 5; index += 1) queue.push(frame(quarter));
		expect(flow.pause).not.toHaveBeenCalled();
		queue.push(frame(quarter));
		expect(flow.pause).toHaveBeenCalledTimes(1);

		releases.shift()?.();
		await flush();
		releases.shift()?.();
		await flush();
		expect(flow.resume).not.toHaveBeenCalled();
		releases.shift()?.();
		await flush();
		expect(flow.resume).toHaveBeenCalledTimes(1);
	});

	it('resumes a paused source when cleared', () => {
		const flow = { pause: jest.fn(), resume: jest.fn() };
		const queue = new HistoryFrameQueue(
			() => new Promise<void>(() => undefined),
			() => true,
			flow,
		);
		const half = 'x'.repeat(HISTORY_REPLAY_QUEUE_HIGH_WATER / 2);
		for (let index = 0; index < 4; index += 1) queue.push(frame(half));
		expect(flow.pause).toHaveBeenCalledTimes(1);
		queue.clear();
		expect(flow.resume).toHaveBeenCalledTimes(1);
		expect(queue.size).toBe(0);
	});
});
