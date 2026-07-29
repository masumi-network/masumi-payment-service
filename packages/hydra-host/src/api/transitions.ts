/**
 * Guarded state transitions requested through the API.
 *
 * The supervisor treats the durable record as authoritative, so an endpoint
 * that writes `desired` or `state` directly is writing straight into the
 * control loop. `plan.ts` encodes which transitions are *legal*, but it only
 * ever sees the record after the fact — it cannot reject a request, and it
 * cannot know a precondition the caller was supposed to satisfy.
 *
 * So every intent goes through this module, which validates the precondition
 * and returns a 409 rather than quietly producing a record the planner will
 * either ignore or act on destructively. Endpoints express intent; they never
 * hand-craft state.
 */

import type { NodeRegistryStore } from '../registry/store.js';
import type { NodeRecord, PeerRecord } from '../registry/types.js';
import { HostApiError } from './http-error.js';

/** States in which no hydra-node process should be running for this record. */
const QUIESCENT_STATES: ReadonlySet<NodeRecord['state']> = new Set(['PendingEscrow', 'Stopped']);

async function load(store: NodeRegistryStore, nodeId: string): Promise<NodeRecord> {
	const record = await store.read(nodeId);
	if (record === null) {
		throw new HostApiError(`no such node: ${nodeId}`, 404);
	}
	return record;
}

function requireAcknowledged(record: NodeRecord): void {
	if (record.escrowAckedAt === null) {
		throw new HostApiError(
			'this node has not been escrow-acknowledged; its keys may exist nowhere else, so it cannot be started',
			409,
		);
	}
}

export async function requestStart(store: NodeRegistryStore, nodeId: string): Promise<NodeRecord> {
	const record = await load(store, nodeId);
	requireAcknowledged(record);
	if (record.peers.length === 0) {
		throw new HostApiError(
			'peers must be configured before starting: --initial-cluster is fixed at boot, so a node started now would bootstrap a cluster the counterparty cannot join',
			409,
		);
	}
	const updated = await store.update(nodeId, (current) => ({ ...current, desired: 'Running' }));
	return updated ?? record;
}

export async function requestStop(store: NodeRegistryStore, nodeId: string): Promise<NodeRecord> {
	await load(store, nodeId);
	const updated = await store.update(nodeId, (current) => ({ ...current, desired: 'Stopped' }));
	return updated ?? (await load(store, nodeId));
}

/**
 * An explicit restart.
 *
 * Setting `desired: 'Running'` alone is not enough: for an already-running node
 * that is indistinguishable from the steady state, so the planner would idle
 * and the request would be a silent no-op. The flag makes the intent visible,
 * and the supervisor clears it once the restart has happened.
 */
export async function requestRestart(store: NodeRegistryStore, nodeId: string): Promise<NodeRecord> {
	const record = await load(store, nodeId);
	requireAcknowledged(record);
	const updated = await store.update(nodeId, (current) => ({
		...current,
		desired: 'Running',
		restartRequested: true,
	}));
	return updated ?? record;
}

/**
 * Removal destroys the node's persistence directory, which is the only copy of
 * its head state on this host — without it the head can never be closed from
 * our side.
 *
 * The Host cannot tell whether a head is finalised; that is the payment
 * service's knowledge. So a node that was never acknowledged (and therefore
 * never started, and holds no head state) may be removed freely, while any
 * acknowledged node requires the caller to assert `force`, which is the caller
 * stating the head is settled.
 */
export async function requestRemoval(
	store: NodeRegistryStore,
	nodeId: string,
	options: { force: boolean },
): Promise<NodeRecord> {
	const record = await load(store, nodeId);
	if (record.escrowAckedAt !== null && !options.force) {
		throw new HostApiError(
			'this node has been live and its persistence directory may hold the only copy of the head state; ' +
				'removing it would make the head impossible to close from this host. Retry with force=true once the head is finalised',
			409,
		);
	}
	const updated = await store.update(nodeId, (current) => ({ ...current, state: 'Removing' }));
	return updated ?? record;
}

/**
 * Peers become etcd's `--initial-cluster`, which is fixed at process start and
 * determines the content-addressed data directory. Changing them under a
 * running node would leave the process on its old cluster and make the next
 * restart bootstrap an empty one, so the node must be quiescent.
 */
export async function requireQuiescentForPeerChange(store: NodeRegistryStore, nodeId: string): Promise<NodeRecord> {
	const record = await load(store, nodeId);
	if (!QUIESCENT_STATES.has(record.state)) {
		throw new HostApiError(
			`peers cannot be changed while the node is ${record.state}: the peer set is fixed at process start, ` +
				'and changing it under a running node would bootstrap a different etcd cluster on the next restart. Stop the node first',
			409,
		);
	}
	return record;
}

export type { PeerRecord };
