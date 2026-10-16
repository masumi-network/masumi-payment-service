/**
 * Build a node's argv from its stored record, and check its stored peers.
 *
 * Peers are checked against the target policy at every launch, and not only
 * when they are stored. A record written before the policy existed, or while
 * `HYDRA_HOST_ALLOW_PRIVATE_PEERS` was on, would otherwise keep dialling a
 * non-public address on every restart. A node that is already running is not
 * checked until its next start.
 */

import path from 'node:path';
import type { HostConfig } from '../config.js';
import type { PeerTargetCheck, PeerTargetRejection } from '../peer-target-policy.js';
import type { NodeRecord } from '../registry/types.js';
import { buildHydraNodeArgs } from './args.js';

/** The first stored peer the policy refuses, or null when all may be dialled. */
export async function checkStoredPeers(
	record: NodeRecord,
	checkPeerTarget: PeerTargetCheck,
): Promise<PeerTargetRejection | null> {
	for (const peer of record.peers) {
		const rejection = await checkPeerTarget(peer.advertise);
		if (rejection !== null) {
			return rejection;
		}
	}
	return null;
}

export function buildLaunchArgs(config: HostConfig, nodeDir: string, record: NodeRecord): string[] {
	const peersDir = path.join(nodeDir, 'peers');
	return buildHydraNodeArgs({
		nodeId: record.nodeId,
		nodeDir,
		network: record.network,
		apiPort: record.apiPort,
		startChainFrom: record.startChainFrom,
		peerPort: record.peerPort,
		// Null unless explicitly enabled: the Prometheus server binds every
		// interface and hydra-node offers no way to confine it.
		monitoringPort: config.monitoringEnabled ? record.monitoringPort : null,
		advertise: record.advertise,
		peers: record.peers.map((peer) => peer.advertise),
		peerHydraVerificationKeyFiles: record.peers.map((_, i) => path.join(peersDir, `${i}-hydra.vk`)),
		peerCardanoVerificationKeyFiles: record.peers.map((_, i) => path.join(peersDir, `${i}-cardano.vk`)),
		ledgerProtocolParametersFile: config.ledgerProtocolParametersFile,
		blockfrostProjectFile: config.blockfrostProjectFile,
		hydraScriptsTxIds: config.hydraScriptsTxIds,
		contestationPeriodSeconds: record.contestationPeriodSeconds,
		depositPeriodSeconds: record.depositPeriodSeconds,
		depositActivationSeconds: record.depositActivationSeconds,
		unsyncedPeriodSeconds: record.unsyncedPeriodSeconds,
		useSystemEtcd: config.useSystemEtcd,
	});
}
