import type { EventEmitter } from 'node:events';
import { HydraErrorType, HydraHeadStatus } from '@/generated/prisma/client';
import { logger } from '@masumi/payment-core/logger';
import { HydraNodeEvent } from '@/lib/hydra/hydra/types';
import { recordHeadError } from '@/services/hydra-head-error/record';

/**
 * How long a recorded replay error stands for its repeats. A history that a
 * frame breaks fails every pass the same way, and the socket reopens about once
 * a second, so each pass otherwise wrote one more identical row.
 */
export const REPLAY_FAILURE_REPEAT_WINDOW_MS = 10 * 60 * 1000;

/**
 * A rejected history is the most consequential failure this service has and
 * used to be its quietest: the session never forms, so there is no head
 * clock, so every L2 escrow operation fails closed, while the connection
 * retries forever and the head goes on reporting itself as Open. Recorded
 * as a head error so the reason is visible where an operator is already
 * looking, instead of only in a log line they have no reason to read.
 *
 * A changed error is recorded at once. The same error is recorded again once
 * per window, so the newest row still shows that the head is stuck.
 */
export function recordReplayFailures(node: EventEmitter, hydraHeadId: string): void {
	/** `at` is monotonic time: a wall clock stepped back would stretch the window. */
	let lastRecorded: { message: string; at: number } | undefined;
	node.on(HydraNodeEvent.HistoryReplayFailed, (error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		const now = performance.now();
		if (lastRecorded?.message === message && now - lastRecorded.at < REPLAY_FAILURE_REPEAT_WINDOW_MS) return;
		const recording = { message, at: now };
		lastRecorded = recording;
		void recordHeadError(hydraHeadId, HydraHeadStatus.Connecting, HydraErrorType.CommandFailed, error, 'HistoryReplay')
			.then((isRecorded) => {
				// No row was written, so the next pass tries again.
				if (!isRecorded && lastRecorded === recording) lastRecorded = undefined;
			})
			.catch((recordError: unknown) => {
				logger.error('[HydraConnectionManager] could not record a rejected history replay', {
					hydraHeadId,
					error: recordError instanceof Error ? recordError.message : recordError,
				});
			});
	});
}
