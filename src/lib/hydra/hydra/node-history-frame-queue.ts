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
 *
 * While frames wait, the socket keeps delivering them, and a history is
 * hundreds of megabytes of full UTxO sets. Above a high-water mark the queue
 * pauses the socket, and resumes it once it has worked down to half.
 */

export const HISTORY_REPLAY_YIELD_BUDGET_MS = 50;

/**
 * Read on every slice, so a test that drives replay frame by frame and asserts
 * synchronously can turn yielding off: on a loaded machine a slice of tiny
 * frames still overruns a wall-clock budget, and the assertion then runs before
 * the frames it checks. Production never changes it.
 */
export const historyReplayYieldSettings = { budgetMs: HISTORY_REPLAY_YIELD_BUDGET_MS };

/**
 * Queued frame text, in UTF-16 code units (bytes, for Hydra's ASCII JSON),
 * above which the socket is paused. Four maximum-size frames.
 */
export const HISTORY_REPLAY_QUEUE_HIGH_WATER = 16 * 1024 * 1024;

export type QueuedHistoryFrame = { rawMessage: string; pass: number };

export class HistoryFrameQueue {
	private readonly frames: QueuedHistoryFrame[] = [];
	/** True while frames are worked, or while the queue waits to resume. */
	private draining = false;
	private queuedLength = 0;
	private paused = false;

	constructor(
		/** Processes one frame; returns a promise only while the frame waits. The promise must not reject. */
		private readonly processFrame: (frame: QueuedHistoryFrame) => Promise<void> | undefined,
		/** False for a frame that must be dropped unread (its pass ended, the replay failed). */
		private readonly isFrameLive: (frame: QueuedHistoryFrame) => boolean,
		/** Pauses and resumes the source of the frames. */
		private readonly flow: { pause(): void; resume(): void },
	) {}

	get size(): number {
		return this.frames.length;
	}

	push(frame: QueuedHistoryFrame): void {
		this.frames.push(frame);
		this.added([frame]);
	}

	/** Queue frames that arrived before everything already queued. */
	pushFront(frames: readonly QueuedHistoryFrame[]): void {
		this.frames.unshift(...frames);
		this.added(frames);
	}

	private added(frames: readonly QueuedHistoryFrame[]): void {
		for (const { rawMessage } of frames) this.queuedLength += rawMessage.length;
		if (!this.paused && this.queuedLength > HISTORY_REPLAY_QUEUE_HIGH_WATER) {
			this.paused = true;
			this.flow.pause();
		}
		this.drain();
	}

	private removed(frame: QueuedHistoryFrame): void {
		this.queuedLength -= frame.rawMessage.length;
		if (this.paused && this.queuedLength <= HISTORY_REPLAY_QUEUE_HIGH_WATER / 2) {
			this.paused = false;
			this.flow.resume();
		}
	}

	/**
	 * Drop every queued frame. A frame already waiting is not cancelled: its
	 * processor is expected to check, when it resumes, whether it still counts.
	 */
	clear(): void {
		this.frames.length = 0;
		this.queuedLength = 0;
		if (this.paused) {
			this.paused = false;
			this.flow.resume();
		}
	}

	private drain(): void {
		if (this.draining) return;
		this.draining = true;
		const sliceStartedAtMs = Date.now();
		while (this.frames.length > 0) {
			if (Date.now() - sliceStartedAtMs >= historyReplayYieldSettings.budgetMs) {
				setImmediate(() => this.resume());
				return;
			}
			const frame = this.frames.shift() as QueuedHistoryFrame;
			this.removed(frame);
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
