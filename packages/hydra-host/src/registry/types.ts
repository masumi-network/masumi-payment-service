/**
 * Durable record of one supervised hydra-node.
 *
 * A node serves exactly one Hydra Head, so this record is created at
 * provisioning and destroyed when the Head is finalised and removed. Its peer
 * port and advertise address are fixed for its whole life: hydra-node
 * content-addresses the etcd data directory by the cluster configuration, and
 * the advertise string is a participant identity on the wire
 * (`msg-<advertise>`, `alive-<advertise>`), so changing either bootstraps a
 * different cluster rather than moving the existing one.
 */

export type NodeState =
	/** Keys generated and ports reserved, node NOT started. The only state in which key material is readable. */
	| 'PendingEscrow'
	/** Escrowed by the payment service; not running. */
	| 'Stopped'
	/**
	 * Process spawned, API not answering yet.
	 *
	 * This is a real state, not a formality: with two participants etcd has no
	 * quorum until both are up, and hydra-node does not open its API until it
	 * has one *and* its chain follower has synced. A node can sit here for
	 * minutes while being entirely healthy.
	 */
	| 'Starting'
	/** Answering its API. A caller may use this node. */
	| 'Running'
	/** Waiting for a snapshot round to settle before stopping. */
	| 'Draining'
	/** Supervisor gave up; needs an operator. */
	| 'Failed'
	| 'Removing';

/** Verdict from comparing the node's chain view against wall clock. */
export type DriftVerdict = 'Healthy' | 'Degraded' | 'Unsynced';

/**
 * What the supervisor's last probe saw.
 *
 * Persisted rather than kept in memory because it is the only thing that can
 * answer "is this node usable?" for a caller that is not the supervisor — and
 * that question is what the health endpoint exists for.
 */
export type NodeObservationRecord = {
	/** ISO timestamp of the probe. A stale value means the supervisor is not ticking. */
	checkedAt: string;
	/** Whether the node's own API answered. */
	responsive: boolean;
	/**
	 * Whether the node's chain follower has caught up.
	 *
	 * Separate from `responsive` because a node that is answering but still
	 * catching up accepts a connection and then refuses every command with
	 * `WaitOnNodeInSync`. Treating it as usable is how a caller ends up with a
	 * head that will not open.
	 */
	chainSynced: boolean;
	/** Null until the node reports a slot at all. */
	drift: DriftVerdict | null;
	/**
	 * How far behind the wall clock the node's chain follower is, in seconds.
	 *
	 * The verdict alone cannot tell an operator whether to wait or intervene:
	 * "Unsynced" reads the same at thirty seconds behind and at fifteen hours.
	 * Null only when the node reported no slot.
	 */
	driftSeconds: number | null;
};

export type NodeDesiredState = 'Running' | 'Stopped';

export type PeerRecord = {
	/** Publicly reachable `host:port`, exactly as the counterparty advertises it. */
	advertise: string;
	/** Envelope `cborHex` of the peer's Hydra verification key. */
	hydraVerificationKey: string;
	/**
	 * Envelope `cborHex` of the peer's node Cardano *verification key* — not the
	 * 28-byte blake2b-224 hash the payment service keeps in its `cardanoVkey`
	 * column. hydra-node needs the key itself for `--cardano-verification-key`.
	 */
	cardanoVerificationKey: string;
};

export type NodeRecord = {
	nodeId: string;
	state: NodeState;
	desired: NodeDesiredState;
	network: 'preprod' | 'mainnet';

	apiPort: number;
	peerPort: number;
	monitoringPort: number;
	/** Our own publicly reachable `host:port`. Immutable for the node's life. */
	advertise: string;

	/** Empty until the cross-org handshake completes; a node cannot start without peers. */
	peers: PeerRecord[];

	contestationPeriodSeconds: number;
	depositPeriodSeconds: number;
	unsyncedPeriodSeconds: number;

	/**
	 * Public material, safe to return from the API at any time. Both are
	 * envelope `cborHex` values; the payment service derives the key hash it
	 * stores as `cardanoVkey` from `cardanoVerificationKey`.
	 */
	hydraVerificationKey: string;
	cardanoVerificationKey: string;

	/** Set by escrow-ack; once set, key material is never returned again. */
	escrowAckedAt: string | null;
	/** Guards provision retries against double-allocating a node. */
	idempotencyKey: string;

	createdAt: string;
	updatedAt: string;

	/** Populated when state is Failed, so an operator sees why without reading logs. */
	failureReason?: string;
	/**
	 * Spawn attempts in the current unhealthy streak, reset once the node is
	 * observed healthy.
	 *
	 * Attempts, not restarts: the counter has to be incremented *before* the
	 * spawn, or a node that dies instantly would have its exit handler's write
	 * clobbered. That makes the first start attempt 1, so the number of
	 * *restarts* — which is what a caller cares about — is one less. The wire
	 * representation does that subtraction rather than reporting a healthy node
	 * as having restarted once.
	 */
	startAttempts: number;
	/** Last supervisor probe. Absent until the node has been observed at least once. */
	lastObservation?: NodeObservationRecord;
	/** True when the last stop could not be drained, so the unwedge check looks harder on the way up. */
	/**
	 * `SLOT.HEADER_HASH` to start observing the chain from, when set.
	 *
	 * For a node so far behind that replaying the gap is not worth it — after
	 * long downtime, where catching up over a rate-limited chain backend can take
	 * longer than the head has left. The node ignores it if its own head state is
	 * newer, so it can only move the starting point forward, and it skips
	 * observation of the window it jumps: an operator decision, never a default.
	 */
	startChainFrom?: string;
	lastStopUndrained: boolean;
	/**
	 * Set by an explicit restart request and cleared once the supervisor has
	 * performed it. Without this an operator's restart of an already-running node
	 * would be indistinguishable from "desired state is Running", and therefore a
	 * silent no-op.
	 */
	restartRequested?: boolean;
};

export function isKeyMaterialReadable(record: NodeRecord): boolean {
	return record.state === 'PendingEscrow' && record.escrowAckedAt === null;
}

export function canStart(record: NodeRecord): boolean {
	return record.peers.length > 0 && record.escrowAckedAt !== null && record.state !== 'Removing';
}

/**
 * Retries in the current unhealthy streak — the attempts beyond the first.
 *
 * A node that came up first time reads 0, which is what an operator means by
 * "it has not restarted". Deliberately not a lifetime total: the number exists
 * to show how close a node is to exhausting its restart budget, and that budget
 * is refunded the moment the node proves it can stay up.
 */
export function restartCountOf(record: NodeRecord): number {
	return Math.max(0, record.startAttempts - 1);
}

/**
 * Whether a caller may route work to this node.
 *
 * Three things all have to hold, and none implies the others. The state must be
 * `Running`; the node must still have been answering at the last probe, since
 * it can stop after being promoted; and its chain follower must be caught up,
 * because a synced-looking node that is actually catching up refuses every
 * command with `WaitOnNodeInSync`.
 */
export function isUsable(record: NodeRecord): boolean {
	const observation = record.lastObservation;
	return record.state === 'Running' && observation?.responsive === true && observation.chainSynced;
}
