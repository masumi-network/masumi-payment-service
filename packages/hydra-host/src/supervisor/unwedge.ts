/**
 * Automatic recovery from a stranded snapshot round.
 *
 * Draining covers voluntary stops, but an OOM kill or host failure bypasses it,
 * and a node killed mid-round can come back permanently stuck: the etcd layer
 * persists `last-known-revision` before the head logic durably consumes the
 * message, so a lost `ReqSn`/`AckSn` is never redelivered and every later
 * transaction fails `TxInvalid`.
 *
 * The recovery is to side-load the node's own last *confirmed* snapshot, which
 * resets the round. This is a port of the procedure already proven in
 * `hydra-l2-flow/run-hydra-e2e.sh` — it needs no counterparty action, and the
 * payment service refuses to treat `SnapshotSideLoaded` as a replay
 * authentication anchor, so recovering a node cannot be used to inject
 * unverified state into the service.
 */

import { getOwnValue, isPlainObject } from '../registry/json.js';
import { isSafeToStop, type LastSeenSnapshotResponse } from './drain.js';

export type UnwedgeOutcome =
	/** No round was in flight; nothing to do. */
	| { kind: 'Healthy' }
	/** A round was in flight but advanced on its own — the node is simply busy. */
	| { kind: 'Progressing'; tag: string | null }
	/** Stranded and recovered by side-loading the confirmed snapshot. */
	| { kind: 'Recovered'; tag: string | null }
	/** Stranded, side-load attempted, still stuck. Needs an operator. */
	| { kind: 'Unrecovered'; tag: string | null; reason: string }
	/**
	 * A shutdown began mid-check. The record is left exactly as it was, so the
	 * undrained stop is still on it and the check runs again on the way back up.
	 */
	| { kind: 'Deferred' };

export type UnwedgeOptions = {
	fetchLastSeen: () => Promise<LastSeenSnapshotResponse>;
	/** `GET /snapshot` — the last confirmed snapshot. */
	fetchConfirmedSnapshot: () => Promise<unknown>;
	/** `POST /snapshot` — side-load. */
	sideLoadSnapshot: (snapshot: unknown) => Promise<void>;
	/** How long to let a round settle before calling it stranded. */
	settleWaitMs: number;
	sleep: (ms: number) => Promise<void>;
	/**
	 * Checked between steps, because this whole procedure can cost ~90 seconds —
	 * a 10s read, a 30s settle wait, two more reads and a side-load — and it runs
	 * inside the tick, holding the node against the shutdown's drain. Charged in
	 * full against a 240s stop grace it does not know about, one unwedge is the
	 * difference between draining the fleet and being SIGKILLed mid-drain.
	 */
	isAborted?: () => boolean;
};

/**
 * A stable fingerprint of an in-flight round, used to tell "stuck" from
 * "advancing". Falls back to the tag alone when the node reports no sequence
 * number, which only costs us a longer settle wait.
 */
export function roundSignature(response: LastSeenSnapshotResponse | null | undefined): string {
	if (!isPlainObject(response)) {
		return 'none';
	}
	const tag = getOwnValue(response, 'tag');
	const parts = [typeof tag === 'string' ? tag : 'unknown'];
	for (const key of ['number', 'snapshotNumber', 'seq', 'sequence']) {
		const value = getOwnValue(response, key);
		if (typeof value === 'number' || typeof value === 'string') {
			parts.push(`${key}=${String(value)}`);
		}
	}
	return parts.join('|');
}

function readTag(response: LastSeenSnapshotResponse | null | undefined): string | null {
	const tag = response?.tag;
	return typeof tag === 'string' ? tag : null;
}

/**
 * Check a node after it comes back up, and recover it if a round is stranded.
 *
 * Deliberately conservative: a round that advances between the two
 * observations is left alone. Side-loading a node that is merely busy would
 * discard in-flight work for no reason.
 */
export async function unwedgeNode(options: UnwedgeOptions): Promise<UnwedgeOutcome> {
	const { fetchLastSeen, fetchConfirmedSnapshot, sideLoadSnapshot, settleWaitMs, sleep, isAborted } = options;
	const aborted = (): boolean => isAborted?.() === true;

	/**
	 * Every read here is guarded, like the side-load and the snapshot read below.
	 *
	 * An escaping rejection is the worst outcome available: `lastStopUndrained`
	 * is never written, `Unwedge` outranks the drift watchdog, and the tick's
	 * per-node catch only logs — so the node replans `Unwedge`, throws, and does
	 * it again every tick for good. It reads as Running and usable the whole
	 * time while its drift watchdog is dead. Reported as unrecoverable instead:
	 * the record goes `Failed` with the reason on it, which is visible and which
	 * an operator can restart out of.
	 */
	const readLastSeen = async (): Promise<
		{ ok: true; value: LastSeenSnapshotResponse | null } | { ok: false; reason: string }
	> => {
		try {
			return { ok: true, value: (await fetchLastSeen()) ?? null };
		} catch (error) {
			return { ok: false, reason: `could not read the last-seen snapshot: ${(error as Error).message}` };
		}
	};

	const firstRead = await readLastSeen();
	if (!firstRead.ok) return { kind: 'Unrecovered', tag: null, reason: firstRead.reason };
	const first = firstRead.value;
	if (isSafeToStop(first)) {
		return { kind: 'Healthy' };
	}

	const before = roundSignature(first);
	if (aborted()) return { kind: 'Deferred' };
	await sleep(settleWaitMs);
	if (aborted()) return { kind: 'Deferred' };
	const secondRead = await readLastSeen();
	if (!secondRead.ok) return { kind: 'Unrecovered', tag: readTag(first), reason: secondRead.reason };
	const second = secondRead.value;

	if (isSafeToStop(second)) {
		return { kind: 'Progressing', tag: readTag(second) };
	}
	if (roundSignature(second) !== before) {
		return { kind: 'Progressing', tag: readTag(second) };
	}

	const tag = readTag(second);
	if (aborted()) return { kind: 'Deferred' };

	let confirmed: unknown;
	try {
		confirmed = await fetchConfirmedSnapshot();
	} catch (error) {
		return {
			kind: 'Unrecovered',
			tag,
			reason: `could not read the confirmed snapshot to side-load: ${(error as Error).message}`,
		};
	}
	if (confirmed === undefined || confirmed === null) {
		// No confirmed snapshot yet means the head has never completed a round,
		// so there is nothing to reset to.
		return { kind: 'Unrecovered', tag, reason: 'the node reports no confirmed snapshot to side-load' };
	}

	try {
		await sideLoadSnapshot(confirmed);
	} catch (error) {
		return { kind: 'Unrecovered', tag, reason: `side-load was rejected: ${(error as Error).message}` };
	}

	// Trust nothing: confirm the side-load actually cleared the round.
	const afterRead = await readLastSeen();
	if (!afterRead.ok) {
		return { kind: 'Unrecovered', tag, reason: `side-load completed but ${afterRead.reason}` };
	}
	const after = afterRead.value;
	if (isSafeToStop(after) || roundSignature(after) !== before) {
		return { kind: 'Recovered', tag };
	}

	return {
		kind: 'Unrecovered',
		tag,
		reason: 'side-load completed but the round is still stranded; the head needs manual inspection',
	};
}
