/**
 * Drain gate for a voluntary node stop.
 *
 * Stopping a node mid-snapshot-round can strand its head: the etcd layer
 * persists `last-known-revision` before the head logic durably consumes the
 * message, so a `ReqSn`/`AckSn` lost in that window is never redelivered and
 * every later transaction fails `TxInvalid`.
 *
 * Draining is a probability reduction, not a guarantee — an OOM kill or host
 * failure bypasses it entirely — so it is paired with the automatic unwedge
 * path rather than relied on for correctness.
 */

import { NodeUnreachableError } from '../errors.js';

/**
 * Tags that mean no snapshot round is in flight. Anything else — including a
 * tag we do not recognise — is treated as unsafe, because the cost of guessing
 * wrong is a permanently stranded head.
 */
const SAFE_TO_STOP_TAGS = new Set(['LastSeenSnapshot', 'NoSeenSnapshot']);

/**
 * The subset of `GET /snapshot/last-seen` this Host depends on.
 *
 * The sequence fields are listed explicitly because `roundSignature` reads them
 * to tell a stuck round from an advancing one. Modelling only `tag` would have
 * left that dependency invisible to the type checker.
 */
export type LastSeenSnapshotResponse = {
	tag?: unknown;
	number?: number | string;
	snapshotNumber?: number | string;
	seq?: number | string;
	sequence?: number | string;
};

export type DrainOutcome = {
	drained: boolean;
	/**
	 * How the wait ended.
	 *
	 * `unreachable` is reported rather than folded into `drained`, because what
	 * it means depends on something only the caller knows: whether the process is
	 * still running. A node that has already exited has nothing left to drain; a
	 * node whose process is alive but has stopped answering is the wedged case
	 * the unwedge check exists for, and calling that one cleanly drained is what
	 * skipped the check for exactly the node that needed it.
	 */
	reason: 'safe' | 'unreachable' | 'timeout';
	/** Last tag observed, for logging when a drain times out. */
	lastTag: string | null;
	waitedMs: number;
};

/**
 * Forwards the drain's per-read budget to the client.
 *
 * Named and exported so it can be tested, because the mistake it exists to
 * prevent is invisible: a zero-parameter `() => client.fetchLastSeen()` still
 * satisfies this option's type — TypeScript accepts narrower arity — so the
 * budget is computed, passed, and silently dropped, and every poll falls back
 * to the client's own 10s default. The drain then overruns its budget by a
 * whole request timeout and the per-node stop is 165s against the 155s the
 * shutdown grace is sized from. A test with its own fake cannot catch it; only
 * one over this function can.
 */
export function drainReader(client: {
	fetchLastSeen: (timeoutMs?: number) => Promise<LastSeenSnapshotResponse>;
}): (timeoutMs?: number) => Promise<LastSeenSnapshotResponse> {
	return (timeoutMs) => client.fetchLastSeen(timeoutMs);
}

export type DrainOptions = {
	/** `timeoutMs` bounds the individual read, so a poll cannot overrun the budget. */
	fetchLastSeen: (timeoutMs?: number) => Promise<LastSeenSnapshotResponse>;
	timeoutMs: number;
	pollIntervalMs: number;
	sleep: (ms: number) => Promise<void>;
	now: () => number;
};

export function isSafeToStop(response: LastSeenSnapshotResponse | null | undefined): boolean {
	const tag = response?.tag;
	return typeof tag === 'string' && SAFE_TO_STOP_TAGS.has(tag);
}

function readTag(response: LastSeenSnapshotResponse | null | undefined): string | null {
	const tag = response?.tag;
	return typeof tag === 'string' ? tag : null;
}

/**
 * Poll until no snapshot round is in flight, or the timeout elapses.
 *
 * A timeout is not an error: the caller still has to stop the node (the
 * platform may be shutting us down), it just records that the stop was
 * undrained so the unwedge check can look harder on the way back up.
 */
export async function waitForDrain(options: DrainOptions): Promise<DrainOutcome> {
	const { fetchLastSeen, timeoutMs, pollIntervalMs, sleep, now } = options;
	const startedAt = now();
	let lastTag: string | null = null;

	for (;;) {
		// Bounded by what is left of the budget, not by the client's own default.
		// The deadline is checked only after a read resolves, so an unbounded poll
		// starting just inside the budget overran it by a full request timeout —
		// 130s against a 120s budget, which makes the per-node stop 165s and the
		// fleet's worst case exceed the shutdown grace the numbers are sized from.
		const remainingMs = Math.max(0, timeoutMs - (now() - startedAt));
		if (remainingMs === 0) {
			return { drained: false, reason: 'timeout', lastTag, waitedMs: now() - startedAt };
		}
		let response: LastSeenSnapshotResponse | null = null;
		try {
			response = await fetchLastSeen(remainingMs);
		} catch (error) {
			if (error instanceof NodeUnreachableError) {
				// Nothing to wait for either way, so stop rather than burn the whole
				// timeout — but say WHY, because only the caller knows whether the
				// process is still there. Reported as drained for a node that has
				// exited; the caller downgrades it when the process is alive.
				return { drained: true, reason: 'unreachable', lastTag, waitedMs: now() - startedAt };
			}
			// It answered with something unusable. That is NOT the same as being
			// gone — the node is live and may have a round in flight — so keep
			// polling and let the timeout decide.
			if (now() - startedAt >= timeoutMs) {
				return { drained: false, reason: 'timeout', lastTag, waitedMs: now() - startedAt };
			}
			await sleep(pollIntervalMs);
			continue;
		}

		lastTag = readTag(response) ?? lastTag;
		if (isSafeToStop(response)) {
			return { drained: true, reason: 'safe', lastTag, waitedMs: now() - startedAt };
		}

		if (now() - startedAt >= timeoutMs) {
			return { drained: false, reason: 'timeout', lastTag, waitedMs: now() - startedAt };
		}

		await sleep(pollIntervalMs);
	}
}
