/**
 * The order-preserving queue history replay works its frames through.
 *
 * A history is thousands of frames that arrive faster than they verify. Worked
 * through back to back on socket events, they starve every timer and socket in
 * the process — database pool connects time out, and every request and job
 * fails with them. This queue works synchronously for as long as the work is
 * synchronous and cheap, and gives the event loop a turn otherwise:
 *
 * - after `HISTORY_REPLAY_YIELD_BUDGET_MS` of continuous work, and
 * - while a frame waits on work done elsewhere (its accumulator, on a worker).
 *
 * Order is the protocol — every frame is judged against the state the one
 * before it left — so nothing overtakes a waiting frame.
 */

export const HISTORY_REPLAY_YIELD_BUDGET_MS = 50;

export type QueuedHistoryFrame = { rawMessage: string; pass: number };

export class HistoryFrameQueue {
	private readonly frames: QueuedHistoryFrame[] = [];
	/** True while frames are worked, or while the queue waits to resume. */
	private draining = false;

	constructor(
		/** Processes one frame; returns a promise only while the frame waits. The promise must not reject. */
		private readonly processFrame: (frame: QueuedHistoryFrame) => Promise<void> | undefined,
		/** False for a frame that must be dropped unread (its pass ended, the replay failed). */
		private readonly isFrameLive: (frame: QueuedHistoryFrame) => boolean,
	) {}

	get size(): number {
		return this.frames.length;
	}

	push(frame: QueuedHistoryFrame): void {
		this.frames.push(frame);
		this.drain();
	}

	/** Queue frames that arrived before everything already queued. */
	pushFront(frames: readonly QueuedHistoryFrame[]): void {
		this.frames.unshift(...frames);
		this.drain();
	}

	/**
	 * Drop every queued frame. A frame already waiting is not cancelled: its
	 * processor is expected to check, when it resumes, whether it still counts.
	 */
	clear(): void {
		this.frames.length = 0;
	}

	private drain(): void {
		if (this.draining) return;
		this.draining = true;
		const sliceStartedAtMs = Date.now();
		while (this.frames.length > 0) {
			if (Date.now() - sliceStartedAtMs >= HISTORY_REPLAY_YIELD_BUDGET_MS) {
				setImmediate(() => this.resume());
				return;
			}
			const frame = this.frames.shift() as QueuedHistoryFrame;
			if (!this.isFrameLive(frame)) continue;
			const waiting = this.processFrame(frame);
			if (waiting) {
				// Resumed either way, so a processor that breaks its no-reject
				// contract stalls nothing behind it.
				void waiting.then(
					() => this.resume(),
					() => this.resume(),
				);
				return;
			}
		}
		this.draining = false;
	}

	private resume(): void {
		this.draining = false;
		this.drain();
	}
}
