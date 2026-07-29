/**
 * Wire representations.
 *
 * The node record is never returned raw. Serialising through an explicit
 * allow-list means a field added to `NodeRecord` later cannot leak onto the
 * API by default — which matters because this record sits next to key
 * material and file paths.
 */

import type { NodeRecord } from '../registry/types.js';

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
	restartCount: number;
	failureReason?: string;
};

/**
 * `apiPort` and `monitoringPort` are deliberately omitted: they are loopback
 * only and of no use to a caller, and publishing them invites someone to try
 * reaching an API that has no authentication of its own.
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
		restartCount: record.restartCount,
	};
	if (record.failureReason !== undefined) {
		publicNode.failureReason = record.failureReason;
	}
	return publicNode;
}
