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
	/** Last tag observed, for logging when a drain times out. */
	lastTag: string | null;
	waitedMs: number;
};

export type DrainOptions = {
	fetchLastSeen: () => Promise<LastSeenSnapshotResponse>;
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
		let response: LastSeenSnapshotResponse | null = null;
		try {
			response = await fetchLastSeen();
		} catch (error) {
			if (error instanceof NodeUnreachableError) {
				// The node is already gone; there is nothing left to drain, so stop
				// waiting rather than burn the timeout.
				return { drained: true, lastTag, waitedMs: now() - startedAt };
			}
			// It answered with something unusable. That is NOT the same as being
			// gone — the node is live and may have a round in flight — so keep
			// polling and let the timeout decide.
			if (now() - startedAt >= timeoutMs) {
				return { drained: false, lastTag, waitedMs: now() - startedAt };
			}
			await sleep(pollIntervalMs);
			continue;
		}

		lastTag = readTag(response) ?? lastTag;
		if (isSafeToStop(response)) {
			return { drained: true, lastTag, waitedMs: now() - startedAt };
		}

		if (now() - startedAt >= timeoutMs) {
			return { drained: false, lastTag, waitedMs: now() - startedAt };
		}

		await sleep(pollIntervalMs);
	}
}
