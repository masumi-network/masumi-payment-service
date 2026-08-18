/**
 * Pure decision layer for the supervisor.
 *
 * Kept separate from the executor so every transition can be asserted in tests
 * rather than inferred from a running process tree. The executor performs the
 * action; this decides which one.
 */

import type { NodeRecord } from '../registry/types.js';
import { shouldRestartForDrift } from './drift.js';

export type SupervisorAction =
	/** Do nothing this tick. */
	| { kind: 'Idle' }
	/** Launch the hydra-node child process. */
	| { kind: 'Start' }
	/** Drain, then stop the child process. */
	| { kind: 'Stop'; reason: string }
	/** Drain, stop, and start again — used for drift recovery. */
	| { kind: 'Restart'; reason: string }
	/** Check for, and recover from, a stranded snapshot round. */
	| { kind: 'Unwedge'; reason: string }
	/** Give up and require an operator. */
	| { kind: 'Fail'; reason: string }
	/** Remove the node and release its port. */
	| { kind: 'Remove'; reason: string };

export type NodeObservation = {
	/** Whether a child process is currently running for this node. */
	processRunning: boolean;
	/** Latest drift verdict, or null when the node is down or not yet probed. */
	drift: 'Healthy' | 'Degraded' | 'Unsynced' | null;
	/** How far behind the node is, in seconds. Null when it reported no slot. */
	driftSeconds: number | null;
	/** True once the node has answered at least one probe since starting. */
	responsive: boolean;
	/** Whether the node's chain follower has caught up. False while it is still syncing. */
	chainSynced: boolean;
	/** Wall-clock ms, injected so decisions stay pure. */
	nowMs: number;
};

export type PlanLimits = {
	/**
	 * Spawn attempts allowed in one unhealthy streak.
	 *
	 * Attempts rather than restarts, because the first start consumes one: the
	 * counter is incremented before the spawn so a node that dies instantly
	 * cannot have its exit handler's write clobbered.
	 */
	maxStartAttempts: number;
	escrowTtlSeconds: number;
};

/**
 * Whether an answering node should be recorded as Running.
 *
 * `Running` means "answering its API" rather than "spawned", so a node that
 * answers belongs in it — including one the record still calls Stopped, which
 * is how a host restart used to strand a live node: the payment service reads
 * this state, and a healthy node recorded as down is one it refuses to use.
 *
 * Intent is what separates a stale record from a deliberate one, so it is
 * consulted rather than overridden:
 *
 *  - `desired === 'Stopped'` is a drain. A node being taken down still answers
 *    for a while, and calling it Running hands the payment service a node it is
 *    about to lose.
 *  - `Failed` is terminal until an operator looks; adopting it hides the very
 *    failure it exists to surface.
 *  - `PendingEscrow` gates key-material readability and `Removing` is teardown.
 *    Neither means "in service" just because a port answers.
 *  - `removalRequested` outranks all of it. It is the only field a teardown
 *    leaves standing once `stop` has overwritten the state.
 */
export function shouldAdoptAsRunning(
	record: Pick<NodeRecord, 'state' | 'desired' | 'removalRequested'>,
	observation: Pick<NodeObservation, 'responsive'>,
): boolean {
	if (!observation.responsive) return false;
	// Removal is the intent `desired` does not carry. `requestRemoval` writes
	// `state: 'Removing'` and this flag and deliberately leaves `desired` alone,
	// because stopping the node overwrites the state with `Draining` and then
	// `Stopped` — the flag is what survives that. A node being torn down is
	// therefore indistinguishable from a healthy one by `desired` alone, and it
	// answers for the whole of its drain: promoted, /health advertised it as
	// usable and the payment service could lock funds into a node whose
	// persistence directory the next `remove()` deletes.
	if (record.removalRequested === true) return false;
	if (record.desired !== 'Running') return false;
	return record.state === 'Starting' || record.state === 'Stopped';
}

function escrowExpired(record: NodeRecord, nowMs: number, ttlSeconds: number): boolean {
	const created = Date.parse(record.createdAt);
	if (!Number.isFinite(created)) {
		return false;
	}
	return nowMs - created > ttlSeconds * 1000;
}

/**
 * Decide the next action for one node.
 *
 * Ordering matters: removal beats everything, an un-acknowledged node is never
 * started, and the restart budget is checked before another restart is issued
 * so a node that cannot start does not loop forever.
 */
export function planNodeAction(record: NodeRecord, observation: NodeObservation, limits: PlanLimits): SupervisorAction {
	// Keyed on the durable flag as well as the state, because the removal itself
	// destroys the state: `remove` stops the node first, and the stop writes
	// `Draining` and then `Stopped` over `Removing`. A host restart inside that
	// window would otherwise resume a node the operator was told was going away.
	if (record.state === 'Removing' || record.removalRequested === true) {
		return { kind: 'Remove', reason: 'removal requested' };
	}

	if (record.state === 'PendingEscrow') {
		// Never start a node the payment service has not acknowledged holding the
		// keys for: an unacknowledged node is one whose keys may exist nowhere else.
		if (escrowExpired(record, observation.nowMs, limits.escrowTtlSeconds)) {
			return { kind: 'Remove', reason: 'provisioned node was never escrow-acknowledged' };
		}
		return { kind: 'Idle' };
	}

	if (record.state === 'Failed') {
		// Terminal to the TIMER, so a failure is never hidden by silent retrying.
		// Not terminal to an operator: this check used to sit above the
		// restart-request check below, so /restart and /start both answered 202
		// and then did nothing, and a Failed node could not be recovered through
		// the API at all. "Until an operator intervenes" has to leave the
		// operator something to do.
		if (record.restartRequested === true) {
			return { kind: 'Restart', reason: 'operator restarted a failed node' };
		}
		return { kind: 'Idle' };
	}

	if (record.desired === 'Stopped') {
		return observation.processRunning ? { kind: 'Stop', reason: 'desired state is stopped' } : { kind: 'Idle' };
	}

	// desired === 'Running' below.

	if (record.peers.length === 0) {
		// --initial-cluster is fixed at boot, so starting before the handshake
		// completes would bootstrap a cluster the counterparty cannot join.
		return { kind: 'Idle' };
	}

	if (!observation.processRunning) {
		if (record.startAttempts >= limits.maxStartAttempts) {
			return {
				kind: 'Fail',
				reason: `node failed to stay up after ${record.startAttempts} attempts; a restart is unlikely to fix it`,
			};
		}
		return { kind: 'Start' };
	}

	if (!observation.responsive) {
		// Spawned but not answering yet. With two participants etcd has no quorum
		// until the peer is up, and hydra-node opens its API only once it has one
		// and its chain follower has synced — so this is the normal way up, not a
		// fault, and the record stays in `Starting` until a probe succeeds.
		//
		// An operator restart is still honoured, because a node that is up but
		// mute is the exact case they reach for it: nothing else here acts on such
		// a node — `Unwedge` needs an answering node and `Fail` only counts start
		// attempts — so returning `Idle` unconditionally made
		// POST /v1/nodes/{id}/restart answer 202 and then do nothing, with the
		// request left sitting on the record for good.
		return record.restartRequested === true
			? { kind: 'Restart', reason: 'restart requested through the API' }
			: { kind: 'Idle' };
	}

	// An explicit operator restart, checked before everything the supervisor
	// decides for itself. It is the intervention of last resort, so it must not
	// be reachable only through a code path that is working: `Unwedge` below
	// runs several node reads and a side-load, and a node that cannot complete
	// them replans `Unwedge` every tick — with the request checked after it, the
	// API answered 202 and the operator had no way in at all. Also checked
	// before drift, since a healthy-looking node is otherwise indistinguishable
	// from the steady state. The not-answering case is handled at the responsive
	// gate above.
	if (record.restartRequested === true) {
		return { kind: 'Restart', reason: 'restart requested through the API' };
	}

	// A stop that could not be drained may have stranded a round; check before
	// trusting the node, and before drift handling, since a wedged node also
	// stops advancing its chain view.
	if (record.lastStopUndrained) {
		return { kind: 'Unwedge', reason: 'previous stop could not be drained' };
	}

	// A restart is the only thing that closes a chain-follower gap. The node's
	// delay-free catch-up runs once, at startup; the poll loop it then enters
	// sleeps an average block time before every block, so it tracks the tip at
	// best and never works off a backlog. Left alone, a node that falls behind
	// reports "catching up" forever and stops accepting input.
	//
	// Waited out rather than acted on at the first breach, because a node that
	// is behind and closing the gap is that same catch-up loop doing its job —
	// restarting it there would throw away the progress. `driftBreachSince` is
	// re-anchored by progress, so its age is time spent behind AND stuck.
	if (shouldRestartForDrift(record, observation.nowMs)) {
		return {
			kind: 'Restart',
			reason:
				`chain follower has been ${observation.driftSeconds ?? '?'}s behind without closing the gap; ` +
				'only a restart re-runs the catch-up that recovers it',
		};
	}

	return { kind: 'Idle' };
}

/**
 * A record this host holds no process handle for that may still be a live node.
 *
 * The drain asked `processes.isRunning`, which answers "do I hold a handle?"
 * rather than "is a process running?". Two ordinary things break that: a SIGTERM
 * arriving before boot has adopted the fleet, and `revalidateAdopted` dropping
 * an entry whose pid check it could not complete. The node was then skipped
 * entirely — `stop`, which re-adopts by pid and would have drained it, was never
 * reached — and the host logged "all nodes drained" and exited 0 while the
 * runtime SIGKILLed a node mid-round.
 *
 * Records that are not supposed to be up are still skipped. Running `stop` on a
 * genuinely stopped node writes `lastStopUndrained`, which schedules a
 * stranded-round check on the next start, so a record saying Stopped or
 * PendingEscrow is left alone. Failed keeps its reason for the same kind of
 * reason: it is an operator-facing state, and a shutdown should not overwrite
 * it with a generic stop.
 */
export function mayStillBeRunning(record: Pick<NodeRecord, 'state' | 'pid'>): boolean {
	if (record.pid === undefined) return false;
	return (
		record.state === 'Starting' ||
		record.state === 'Running' ||
		record.state === 'Draining' ||
		record.state === 'Removing'
	);
}
