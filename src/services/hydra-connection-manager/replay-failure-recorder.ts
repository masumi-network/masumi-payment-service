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
 * How long a pass waits after a write that failed. A database outage then costs
 * one insert per head per interval, not one per pass.
 */
export const REPLAY_FAILURE_RETRY_MS = 30 * 1000;

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
	/** Monotonic time: a wall clock stepped back would stretch the wait. */
	let lastRecorded: { message: string; nextRecordAt: number } | undefined;
	node.on(HydraNodeEvent.HistoryReplayFailed, (error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		const now = performance.now();
		if (lastRecorded?.message === message && now < lastRecorded.nextRecordAt) return;
		const recording = { message, nextRecordAt: now + REPLAY_FAILURE_REPEAT_WINDOW_MS };
		lastRecorded = recording;
		void recordHeadError(hydraHeadId, HydraHeadStatus.Connecting, HydraErrorType.CommandFailed, error, 'HistoryReplay')
			.then((isRecorded) => {
				// No row was written, so a later pass tries again. A newer recording is
				// another object, so this never shortens its wait.
				if (!isRecorded) recording.nextRecordAt = now + REPLAY_FAILURE_RETRY_MS;
			})
			.catch((recordError: unknown) => {
				logger.error('[HydraConnectionManager] could not record a rejected history replay', {
					hydraHeadId,
					error: recordError instanceof Error ? recordError.message : recordError,
				});
			});
	});
}
