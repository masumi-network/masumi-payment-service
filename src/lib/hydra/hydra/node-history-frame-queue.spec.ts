import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { HISTORY_REPLAY_YIELD_BUDGET_MS, HistoryFrameQueue, type QueuedHistoryFrame } from './node-history-frame-queue';

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
});
