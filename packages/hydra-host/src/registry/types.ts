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
	| 'Starting'
	| 'Running'
	/** Waiting for a snapshot round to settle before stopping. */
	| 'Draining'
	/** Supervisor gave up; needs an operator. */
	| 'Failed'
	| 'Removing';

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
	/** Counts consecutive supervisor restarts; reset on a healthy sync. */
	restartCount: number;
	/** True when the last stop could not be drained, so the unwedge check looks harder on the way up. */
	lastStopUndrained: boolean;
};

export function isKeyMaterialReadable(record: NodeRecord): boolean {
	return record.state === 'PendingEscrow' && record.escrowAckedAt === null;
}

export function canStart(record: NodeRecord): boolean {
	return record.peers.length > 0 && record.escrowAckedAt !== null && record.state !== 'Removing';
}
