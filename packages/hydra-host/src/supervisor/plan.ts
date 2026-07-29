/**
 * Pure decision layer for the supervisor.
 *
 * Kept separate from the executor so every transition can be asserted in tests
 * rather than inferred from a running process tree. The executor performs the
 * action; this decides which one.
 */

import type { NodeRecord } from '../registry/types.js';

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
	/** True once the node has answered at least one probe since starting. */
	responsive: boolean;
	/** Wall-clock ms, injected so decisions stay pure. */
	nowMs: number;
};

export type PlanLimits = {
	maxConsecutiveRestarts: number;
	escrowTtlSeconds: number;
};

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
	if (record.state === 'Removing') {
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
		// Terminal until an operator intervenes. Retrying on a timer would hide
		// the failure and keep the head unusable.
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
		if (record.restartCount >= limits.maxConsecutiveRestarts) {
			return {
				kind: 'Fail',
				reason: `node failed to stay up after ${record.restartCount} attempts; a restart is unlikely to fix it`,
			};
		}
		return { kind: 'Start' };
	}

	if (!observation.responsive) {
		// Running but not answering yet — still coming up.
		return { kind: 'Idle' };
	}

	// A stop that could not be drained may have stranded a round; check before
	// trusting the node, and before drift handling, since a wedged node also
	// stops advancing its chain view.
	if (record.lastStopUndrained) {
		return { kind: 'Unwedge', reason: 'previous stop could not be drained' };
	}

	// An explicit operator restart. Checked before drift so the request is
	// honoured even when the node looks healthy — otherwise it would be
	// indistinguishable from the steady state and silently ignored.
	if (record.restartRequested === true) {
		return { kind: 'Restart', reason: 'restart requested through the API' };
	}

	if (observation.drift === 'Unsynced') {
		return {
			kind: 'Restart',
			reason: 'chain follower drift passed the guard; the node will reject input until restarted',
		};
	}

	return { kind: 'Idle' };
}
