/**
 * Wire representations.
 *
 * The node record is never returned raw. Serialising through an explicit
 * allow-list means a field added to `NodeRecord` later cannot leak onto the
 * API by default — which matters because this record sits next to key
 * material and file paths.
 */

import { restartCountOf, isUsable, type NodeRecord } from '../registry/types.js';

export type PublicNode = {
	nodeId: string;
	state: string;
	desired: string;
	network: string;
	peerPort: number;
	advertise: string;
	peers: Array<{ advertise: string; hydraVerificationKey: string; cardanoVerificationKey: string }>;
	hydraVerificationKey: string;
	cardanoVerificationKey: string;
	contestationPeriodSeconds: number;
	depositPeriodSeconds: number;
	unsyncedPeriodSeconds: number;
	escrowAckedAt: string | null;
	createdAt: string;
	updatedAt: string;
	/**
	 * Retries within the current unhealthy streak — zero for a node that came up
	 * first time, and zero again once it is healthy. Not a lifetime total.
	 */
	restartCount: number;
	/** Whether a caller may route work here: `Running`, answering, and chain-synced. */
	usable: boolean;
	/** What the last supervisor probe saw. Null before the first probe. */
	responsive: boolean | null;
	/** False while the chain follower is still catching up, when commands are refused. */
	chainSynced: boolean | null;
	drift: string | null;
	lastCheckedAt: string | null;
	failureReason?: string;
};

/**
 * `apiPort` and `monitoringPort` are deliberately omitted. The API port is
 * loopback only and of no use to a caller, and publishing it invites someone to
 * try reaching an API that has no authentication of its own. The monitoring
 * port is worse — it cannot be confined to loopback at all — so naming it here
 * would advertise the one port a node exposes without auth.
 */
export function toPublicNode(record: NodeRecord): PublicNode {
	const publicNode: PublicNode = {
		nodeId: record.nodeId,
		state: record.state,
		desired: record.desired,
		network: record.network,
		peerPort: record.peerPort,
		advertise: record.advertise,
		peers: record.peers.map((peer) => ({
			advertise: peer.advertise,
			hydraVerificationKey: peer.hydraVerificationKey,
			cardanoVerificationKey: peer.cardanoVerificationKey,
		})),
		hydraVerificationKey: record.hydraVerificationKey,
		cardanoVerificationKey: record.cardanoVerificationKey,
		contestationPeriodSeconds: record.contestationPeriodSeconds,
		depositPeriodSeconds: record.depositPeriodSeconds,
		unsyncedPeriodSeconds: record.unsyncedPeriodSeconds,
		escrowAckedAt: record.escrowAckedAt,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		restartCount: restartCountOf(record),
		usable: isUsable(record),
		responsive: record.lastObservation?.responsive ?? null,
		chainSynced: record.lastObservation?.chainSynced ?? null,
		drift: record.lastObservation?.drift ?? null,
		lastCheckedAt: record.lastObservation?.checkedAt ?? null,
	};
	if (record.failureReason !== undefined) {
		publicNode.failureReason = record.failureReason;
	}
	return publicNode;
}
