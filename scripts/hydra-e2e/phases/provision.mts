/**
 * Provisioning and the two-phase key escrow.
 *
 * The escrow exists so key material can never end up living only on the Host.
 * The Host discloses it exactly once, in the provisioning response, and seals
 * the path on escrow-ack. The idempotency key is what makes that safe: if the
 * response is lost, the caller retries and gets the same material rather than a
 * second node whose keys nobody holds.
 */

import { check, equals, phase } from '../check.mjs';
import { http } from '../procs.mjs';
import type { RunningHost } from './hosts.mjs';

export type NodeHandle = {
	host: RunningHost;
	nodeId: string;
	advertise: string;
	peerPort: number;
	hydraVerificationKey: string;
	cardanoVerificationKey: string;
};

const PERIODS = { contestationPeriodSeconds: 220, depositPeriodSeconds: 300, unsyncedPeriodSeconds: 1800 };

type ProvisionBody = {
	nodeId?: string;
	state?: string;
	advertise?: string;
	peerPort?: number;
	hydraVerificationKey?: string;
	cardanoVerificationKey?: string;
	secrets?: { hydraSigningKey?: string; cardanoSigningKey?: string } | null;
	apiPort?: number;
	monitoringPort?: number;
	escrowAckedAt?: string | null;
};

async function provision(host: RunningHost, key: string, periods = PERIODS): Promise<ProvisionBody> {
	const result = await http(`${host.spec.baseUrl}/v1/nodes`, {
		method: 'POST',
		token: host.spec.adminToken,
		idempotencyKey: key,
		body: periods,
	});
	if (result.status !== 200 && result.status !== 201) {
		throw new Error(`provision failed (${result.status}): ${result.text}`);
	}
	return (result.body ?? {}) as ProvisionBody;
}

export async function provisionOn(host: RunningHost, key: string): Promise<NodeHandle> {
	const body = await provision(host, key);
	return {
		host,
		nodeId: body.nodeId ?? '',
		advertise: body.advertise ?? '',
		peerPort: body.peerPort ?? 0,
		hydraVerificationKey: body.hydraVerificationKey ?? '',
		cardanoVerificationKey: body.cardanoVerificationKey ?? '',
	};
}

export async function escrowAck(node: NodeHandle): Promise<void> {
	const result = await http(`${node.host.spec.baseUrl}/v1/nodes/${node.nodeId}/escrow-ack`, {
		method: 'POST',
		token: node.host.spec.adminToken,
	});
	if (result.status !== 200) {
		throw new Error(`escrow-ack failed (${result.status}): ${result.text}`);
	}
}

/**
 * Exercise the escrow contract on a throwaway node.
 *
 * Uses its own node so the assertions cannot disturb the pair that goes on to
 * form the head; it is removed at the end.
 */
export async function checkEscrowContract(host: RunningHost): Promise<void> {
	phase('provision: escrow contract');

	const key = `escrow-contract-${Date.now()}`;
	const first = await provision(host, key);

	equals('provisioned node starts in PendingEscrow', first.state, 'PendingEscrow');
	check(
		'provisioning discloses the hydra signing key',
		typeof first.secrets?.hydraSigningKey === 'string' && first.secrets.hydraSigningKey.length > 0,
	);
	check(
		'provisioning discloses the cardano signing key',
		typeof first.secrets?.cardanoSigningKey === 'string' && first.secrets.cardanoSigningKey.length > 0,
	);
	check(
		'provisioning returns public verification keys',
		typeof first.hydraVerificationKey === 'string' &&
			first.hydraVerificationKey.length > 0 &&
			typeof first.cardanoVerificationKey === 'string' &&
			first.cardanoVerificationKey.length > 0,
	);
	check(
		'the wire record hides the loopback API and monitoring ports',
		first.apiPort === undefined && first.monitoringPort === undefined,
		`apiPort=${String(first.apiPort)} monitoringPort=${String(first.monitoringPort)}`,
	);
	equals('escrowAckedAt is null before acknowledgement', first.escrowAckedAt, null);

	// A lost response must be recoverable.
	const replay = await provision(host, key);
	equals('replaying the idempotency key returns the same node', replay.nodeId, first.nodeId);
	equals(
		'replaying before acknowledgement re-discloses the key',
		replay.secrets?.hydraSigningKey,
		first.secrets?.hydraSigningKey,
	);

	// ...but only of the same request.
	const mismatched = await http(`${host.spec.baseUrl}/v1/nodes`, {
		method: 'POST',
		token: host.spec.adminToken,
		idempotencyKey: key,
		body: { ...PERIODS, contestationPeriodSeconds: 999 },
	});
	equals('reusing the key with different periods is refused', mismatched.status, 409);

	// Before escrow-ack the keys may exist only on the Host, so starting is
	// refused for that reason first.
	const beforeAck = await http(`${host.spec.baseUrl}/v1/nodes/${first.nodeId ?? ''}/start`, {
		method: 'POST',
		token: host.spec.adminToken,
	});
	check(
		'starting an unacknowledged node is refused',
		beforeAck.status === 409 && beforeAck.text.includes('escrow-acknowledged'),
		`status ${beforeAck.status}: ${beforeAck.text.slice(0, 120)}`,
	);

	const acked = await http(`${host.spec.baseUrl}/v1/nodes/${first.nodeId ?? ''}/escrow-ack`, {
		method: 'POST',
		token: host.spec.adminToken,
	});
	equals('escrow-ack succeeds', acked.status, 200);

	// ...and after acknowledgement, for the separate reason that etcd's
	// --initial-cluster is fixed at process start.
	const withoutPeers = await http(`${host.spec.baseUrl}/v1/nodes/${first.nodeId ?? ''}/start`, {
		method: 'POST',
		token: host.spec.adminToken,
	});
	check(
		'starting a node with no peers is refused',
		withoutPeers.status === 409 && withoutPeers.text.includes('peers'),
		`status ${withoutPeers.status}: ${withoutPeers.text.slice(0, 120)}`,
	);

	const sealed = await provision(host, key);
	equals('replaying after acknowledgement returns the node', sealed.nodeId, first.nodeId);
	check(
		'replaying after acknowledgement no longer discloses secrets',
		sealed.secrets === null || sealed.secrets === undefined,
		JSON.stringify(sealed.secrets ?? null),
	);

	const fetched = await http(`${host.spec.baseUrl}/v1/nodes/${first.nodeId ?? ''}`, { token: host.spec.adminToken });
	const fetchedBody = (fetched.body ?? {}) as ProvisionBody;
	check(
		'reading the node back never discloses secrets',
		fetchedBody.secrets === null || fetchedBody.secrets === undefined,
	);
	check('the node records its acknowledgement time', typeof fetchedBody.escrowAckedAt === 'string');

	// An acknowledged node holds head state the Host cannot reason about, so
	// removal is the caller's assertion that the head is settled.
	const unforced = await http(`${host.spec.baseUrl}/v1/nodes/${first.nodeId ?? ''}`, {
		method: 'DELETE',
		token: host.spec.adminToken,
	});
	equals('removing an acknowledged node without force is refused', unforced.status, 409);

	const removed = await http(`${host.spec.baseUrl}/v1/nodes/${first.nodeId ?? ''}?force=true`, {
		method: 'DELETE',
		token: host.spec.adminToken,
	});
	check('a forced removal is accepted', removed.status < 400, `status ${removed.status}`);

	// A node that was never acknowledged has no head state, so it needs no force.
	const orphan = await provision(host, `escrow-orphan-${Date.now()}`);
	const orphanRemoved = await http(`${host.spec.baseUrl}/v1/nodes/${orphan.nodeId ?? ''}`, {
		method: 'DELETE',
		token: host.spec.adminToken,
	});
	check(
		'an unacknowledged node can be removed without force',
		orphanRemoved.status < 400,
		`status ${orphanRemoved.status}`,
	);
}

/** Point each node at the other, which is what makes them one cluster. */
export async function crossLinkPeers(left: NodeHandle, right: NodeHandle): Promise<void> {
	phase('provision: peering');

	for (const [node, peer] of [
		[left, right],
		[right, left],
	] as const) {
		const result = await http(`${node.host.spec.baseUrl}/v1/nodes/${node.nodeId}`, {
			method: 'PATCH',
			token: node.host.spec.adminToken,
			body: {
				peers: [
					{
						advertise: peer.advertise,
						hydraVerificationKey: peer.hydraVerificationKey,
						cardanoVerificationKey: peer.cardanoVerificationKey,
					},
				],
			},
		});
		equals(`${node.host.spec.name} accepted its peer`, result.status, 200);
	}

	check(
		'the two nodes advertise different endpoints',
		left.advertise !== right.advertise,
		`${left.advertise} vs ${right.advertise}`,
	);
	check(
		'the two nodes have different hydra keys',
		left.hydraVerificationKey !== right.hydraVerificationKey,
		'distinct participants',
	);
}
