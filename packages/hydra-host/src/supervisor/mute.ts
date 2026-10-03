/**
 * A node that is up and has stopped answering.
 *
 * The responsive gate treats "not answering" as the normal way up: with two
 * participants etcd has no quorum until the peer arrives, and hydra-node opens
 * its API only once it has one. That reasoning holds for a node that has never
 * answered. It does not hold for one that has: a `Running` record means a probe
 * succeeded, so silence afterwards is a hydra-node with a wedged event loop or
 * a hung etcd client, and nothing else in the planner closes that case —
 * `diedUnobserved` needs the process to be gone, the drift watchdog needs a
 * verdict (and `observe()` reports `drift: null` for a node that did not answer
 * the probe), `Unwedge` needs an answering node, and `Fail` only counts start
 * attempts. So the node idled on every tick, forever: unusable to the payment
 * service, and dead to the head it belongs to until a human noticed.
 *
 * Modelled on the drift breach rather than acted on at the first miss. One
 * missed probe is a slow tick or a busy host, and restarting there throws away
 * a node that was about to answer.
 */

import type { NodeState } from '../registry/types.js';

/**
 * How long a node that has answered before may stay silent.
 *
 * Long enough to ride out a GC pause, a slow chain probe and a couple of missed
 * ticks; short enough that a wedged node is back before the head's next
 * settlement window.
 */
export const MUTE_STALL_MS = 180_000;

/** Guards against a node that restarts, comes up mute again, and restarts again. */
export const MUTE_RESTART_COOLDOWN_MS = 600_000;

export type MuteState = {
	muteSince?: string;
};

type MuteObservation = {
	processRunning: boolean;
	responsive: boolean;
	nowMs: number;
};

/**
 * Start, hold or clear the silence clock.
 *
 * Only a node the record calls `Running` is clocked. `Starting` is the normal
 * way up and is deliberately unbounded; a node whose process is gone is the
 * start budget's business, not this one's.
 */
export function muteFields(
	current: MuteState & { state: NodeState },
	observation: MuteObservation,
): MuteState | Record<string, never> {
	const clockable = current.state === 'Running' && observation.processRunning;
	if (!clockable || observation.responsive) {
		// Undefined rather than omitted: this has to clear the stored field.
		return current.muteSince === undefined ? {} : { muteSince: undefined };
	}
	if (current.muteSince !== undefined) return {};
	return { muteSince: new Date(observation.nowMs).toISOString() };
}

/** Whether a node that has gone silent has been silent long enough, and may be restarted again. */
export function shouldRestartForMute(
	record: { muteSince?: string; lastMuteRestartAt?: string },
	nowMs: number,
): boolean {
	if (record.muteSince === undefined) return false;
	const since = Date.parse(record.muteSince);
	if (!Number.isFinite(since) || nowMs - since < MUTE_STALL_MS) return false;
	if (record.lastMuteRestartAt !== undefined) {
		const last = Date.parse(record.lastMuteRestartAt);
		if (Number.isFinite(last) && nowMs - last < MUTE_RESTART_COOLDOWN_MS) return false;
	}
	return true;
}
