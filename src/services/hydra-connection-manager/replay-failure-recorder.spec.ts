import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { HydraNodeEvent } from '@/lib/hydra/hydra/types';

const mockCreate = jest.fn<(_args: unknown) => Promise<unknown>>();

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraHeadError: { create: mockCreate } },
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { recordReplayFailures, REPLAY_FAILURE_REPEAT_WINDOW_MS, REPLAY_FAILURE_RETRY_MS } =
	await import('./replay-failure-recorder');

const PASS_INTERVAL_MS = 1000;
const HEAD_ID_MISMATCH = 'Hydra frame head id did not match the pinned head';
const GREETINGS_WITHOUT_HEAD = 'Pinned Hydra history Greetings omitted its head identifier';

function recordedMessages(): string[] {
	return mockCreate.mock.calls.map(([args]) => (args as { data: { errorMessage: string } }).data.errorMessage);
}

async function failPass(node: EventEmitter, message: string): Promise<void> {
	node.emit(HydraNodeEvent.HistoryReplayFailed, new Error(message));
	await jest.advanceTimersByTimeAsync(PASS_INTERVAL_MS);
}

beforeEach(() => {
	jest.useFakeTimers({ now: new Date('2026-10-22T10:00:00Z') });
	mockCreate.mockReset();
	mockCreate.mockResolvedValue({});
});

afterEach(() => {
	jest.useRealTimers();
});

describe('recordReplayFailures', () => {
	// A frame that breaks the history fails every pass the same way, and the
	// socket reopens about once a second: one row per pass filled the table.
	it('records a repeated replay error once per window', async () => {
		const node = new EventEmitter();
		recordReplayFailures(node, 'head-1');

		for (let pass = 0; pass < 5; pass += 1) await failPass(node, HEAD_ID_MISMATCH);
		expect(recordedMessages()).toEqual([HEAD_ID_MISMATCH]);

		await jest.advanceTimersByTimeAsync(REPLAY_FAILURE_REPEAT_WINDOW_MS);
		await failPass(node, HEAD_ID_MISMATCH);
		await failPass(node, HEAD_ID_MISMATCH);
		expect(recordedMessages()).toHaveLength(2);
	});

	it('records a changed replay error at once', async () => {
		const node = new EventEmitter();
		recordReplayFailures(node, 'head-1');

		await failPass(node, HEAD_ID_MISMATCH);
		await failPass(node, GREETINGS_WITHOUT_HEAD);

		expect(recordedMessages()).toEqual([HEAD_ID_MISMATCH, GREETINGS_WITHOUT_HEAD]);
	});

	// A write that failed left no row, so waiting out the window would hide the
	// stuck head for that long. Trying on every pass would hit a database that is
	// down once a second per head.
	it('tries again after the retry wait when the write failed', async () => {
		mockCreate.mockRejectedValueOnce(new Error('database unavailable'));
		const node = new EventEmitter();
		recordReplayFailures(node, 'head-1');

		await failPass(node, HEAD_ID_MISMATCH);
		await failPass(node, HEAD_ID_MISMATCH);
		expect(mockCreate).toHaveBeenCalledTimes(1);

		await jest.advanceTimersByTimeAsync(REPLAY_FAILURE_RETRY_MS);
		await failPass(node, HEAD_ID_MISMATCH);
		expect(mockCreate).toHaveBeenCalledTimes(2);
	});

	// The older write fails after a newer error recorded. Only the older error
	// waits less: the newer one already has its row.
	it('keeps a newer error waiting when an older write fails late', async () => {
		let failFirstWrite!: (error: Error) => void;
		mockCreate.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					failFirstWrite = reject;
				}),
		);
		const node = new EventEmitter();
		recordReplayFailures(node, 'head-1');

		node.emit(HydraNodeEvent.HistoryReplayFailed, new Error(HEAD_ID_MISMATCH));
		await failPass(node, GREETINGS_WITHOUT_HEAD);
		failFirstWrite(new Error('database unavailable'));
		await jest.advanceTimersByTimeAsync(REPLAY_FAILURE_RETRY_MS);
		await failPass(node, GREETINGS_WITHOUT_HEAD);

		expect(recordedMessages()).toEqual([HEAD_ID_MISMATCH, GREETINGS_WITHOUT_HEAD]);
	});
});
