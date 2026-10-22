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

const { forgetReplayFailures, recordReplayFailures, REPLAY_FAILURE_REPEAT_WINDOW_MS, REPLAY_FAILURE_RETRY_MS } =
	await import('./replay-failure-recorder');

const HEAD_ID = 'head-1';
const PASS_INTERVAL_MS = 1000;
const HEAD_ID_MISMATCH = 'Hydra frame head id did not match the pinned head';
const GREETINGS_WITHOUT_HEAD = 'Pinned Hydra history Greetings omitted its head identifier';

/** Every insert tried, the failed ones included. */
function attemptedMessages(): string[] {
	return mockCreate.mock.calls.map(([args]) => (args as { data: { errorMessage: string } }).data.errorMessage);
}

async function failPass(node: EventEmitter, message: string): Promise<void> {
	node.emit(HydraNodeEvent.HistoryReplayFailed, new Error(message));
	await jest.advanceTimersByTimeAsync(PASS_INTERVAL_MS);
}

beforeEach(() => {
	forgetReplayFailures(HEAD_ID);
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
		recordReplayFailures(node, HEAD_ID);

		// A pass every second through a whole window, then two into the next: one
		// records, one is skipped. A window that slid with each skipped pass would
		// never record again, and one not renewed would record a third row.
		// Synchronous: a write that succeeds changes nothing the next pass reads.
		const passes = REPLAY_FAILURE_REPEAT_WINDOW_MS / PASS_INTERVAL_MS + 2;
		for (let pass = 0; pass < passes; pass += 1) {
			node.emit(HydraNodeEvent.HistoryReplayFailed, new Error(HEAD_ID_MISMATCH));
			jest.advanceTimersByTime(PASS_INTERVAL_MS);
		}

		expect(attemptedMessages()).toEqual([HEAD_ID_MISMATCH, HEAD_ID_MISMATCH]);
	});

	// A connect that fails tears its attachment down, and the next one has a new
	// node and recorder. The window must hold across them.
	it('keeps the window across a new attachment of the same head', async () => {
		const firstNode = new EventEmitter();
		recordReplayFailures(firstNode, HEAD_ID);
		await failPass(firstNode, HEAD_ID_MISMATCH);

		const nextNode = new EventEmitter();
		recordReplayFailures(nextNode, HEAD_ID);
		await failPass(nextNode, HEAD_ID_MISMATCH);

		expect(attemptedMessages()).toEqual([HEAD_ID_MISMATCH]);
	});

	it('records a changed replay error at once', async () => {
		const node = new EventEmitter();
		recordReplayFailures(node, HEAD_ID);

		await failPass(node, HEAD_ID_MISMATCH);
		await failPass(node, GREETINGS_WITHOUT_HEAD);

		expect(attemptedMessages()).toEqual([HEAD_ID_MISMATCH, GREETINGS_WITHOUT_HEAD]);
	});

	// A write that failed left no row, so waiting out the window would hide the
	// stuck head for that long. Trying on every pass would hit a database that is
	// down once a second per head.
	it('tries again after the retry wait when the write failed', async () => {
		mockCreate.mockRejectedValueOnce(new Error('database unavailable'));
		const node = new EventEmitter();
		recordReplayFailures(node, HEAD_ID);

		await failPass(node, HEAD_ID_MISMATCH);
		await failPass(node, HEAD_ID_MISMATCH);
		expect(mockCreate).toHaveBeenCalledTimes(1);

		await jest.advanceTimersByTimeAsync(REPLAY_FAILURE_RETRY_MS);
		await failPass(node, HEAD_ID_MISMATCH);
		expect(mockCreate).toHaveBeenCalledTimes(2);
	});

	// The older write fails after a newer error recorded. That late failure must
	// not shorten the newer error's window.
	it('keeps a newer error waiting when an older write fails late', async () => {
		let failFirstWrite!: (error: Error) => void;
		mockCreate.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					failFirstWrite = reject;
				}),
		);
		const node = new EventEmitter();
		recordReplayFailures(node, HEAD_ID);

		node.emit(HydraNodeEvent.HistoryReplayFailed, new Error(HEAD_ID_MISMATCH));
		await failPass(node, GREETINGS_WITHOUT_HEAD);
		failFirstWrite(new Error('database unavailable'));
		await jest.advanceTimersByTimeAsync(REPLAY_FAILURE_RETRY_MS);
		await failPass(node, GREETINGS_WITHOUT_HEAD);

		expect(attemptedMessages()).toEqual([HEAD_ID_MISMATCH, GREETINGS_WITHOUT_HEAD]);
	});
});
