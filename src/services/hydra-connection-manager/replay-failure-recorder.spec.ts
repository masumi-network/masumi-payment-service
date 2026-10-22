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

const { recordReplayFailures, REPLAY_FAILURE_REPEAT_WINDOW_MS } = await import('./replay-failure-recorder');

const PASS_INTERVAL_MS = 1000;

function recordedMessages(): string[] {
	return mockCreate.mock.calls.map(([args]) => (args as { data: { errorMessage: string } }).data.errorMessage);
}

function failPass(node: EventEmitter, message: string): void {
	node.emit(HydraNodeEvent.HistoryReplayFailed, new Error(message));
	jest.advanceTimersByTime(PASS_INTERVAL_MS);
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
	it('records a repeated replay error once per window', () => {
		const node = new EventEmitter();
		recordReplayFailures(node, 'head-1');

		for (let pass = 0; pass < 5; pass += 1) failPass(node, 'Hydra frame head id did not match the pinned head');
		expect(recordedMessages()).toEqual(['Hydra frame head id did not match the pinned head']);

		jest.advanceTimersByTime(REPLAY_FAILURE_REPEAT_WINDOW_MS);
		failPass(node, 'Hydra frame head id did not match the pinned head');
		expect(recordedMessages()).toHaveLength(2);
	});

	it('records a changed replay error at once', () => {
		const node = new EventEmitter();
		recordReplayFailures(node, 'head-1');

		failPass(node, 'Hydra frame head id did not match the pinned head');
		failPass(node, 'Pinned Hydra history Greetings omitted its head identifier');

		expect(recordedMessages()).toEqual([
			'Hydra frame head id did not match the pinned head',
			'Pinned Hydra history Greetings omitted its head identifier',
		]);
	});
});
