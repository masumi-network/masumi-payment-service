/**
 * Two-phase node provisioning.
 *
 * The Host generates a node's keys and discloses them exactly once, in the
 * `POST /v1/nodes` response, while holding the node in `PendingEscrow` and
 * NOT starting it. The payment service persists them encrypted and then calls
 * escrow-ack, which starts the node and permanently seals the disclosure path.
 *
 * The idempotency key closes the window that would otherwise exist: if the
 * provision response is lost in transit, the caller retries with the same key
 * and gets the same material back, because the node is still un-acked. Without
 * that, a lost response would leave a node whose keys exist only on the Host —
 * precisely the orphan the escrow design is meant to prevent.
 *
 * After escrow-ack, no endpoint returns key material again, and a retry with
 * the original idempotency key gets the record without secrets.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { generateCardanoKeyPair, generateHydraKeyPair, serializeEnvelope } from '../keys.js';
import type { PortAllocator } from '../registry/ports.js';
import type { NodeRegistryStore } from '../registry/store.js';
import type { NodeRecord, PeerRecord } from '../registry/types.js';
import { HostApiError, type HttpErrorStatus } from './http-error.js';
import { requireQuiescentForPeerChange } from './transitions.js';

export class ProvisionError extends HostApiError {
	constructor(message: string, status: HttpErrorStatus) {
		super(message, status);
		this.name = 'ProvisionError';
	}
}

export type ProvisionRequest = {
	idempotencyKey: string;
	network: 'preprod' | 'mainnet';
	contestationPeriodSeconds: number;
	depositPeriodSeconds: number;
	unsyncedPeriodSeconds: number;
};

export type ProvisionSecrets = {
	hydraSigningKey: string;
	cardanoSigningKey: string;
};

export type ProvisionResult = {
	record: NodeRecord;
	/** Present only while the node is un-acked. */
	secrets: ProvisionSecrets | null;
	/** True when an existing un-acked node was returned instead of a new one. */
	replayed: boolean;
};

export type ProvisionDeps = {
	store: NodeRegistryStore;
	ports: PortAllocator;
	advertiseFor: (peerPort: number) => string;
	newNodeId: () => string;
	now: () => Date;
};

/** Key material is readable only before escrow-ack, and only then. */
export function mayDiscloseSecrets(record: NodeRecord): boolean {
	return record.state === 'PendingEscrow' && record.escrowAckedAt === null;
}

async function readSecrets(store: NodeRegistryStore, nodeId: string): Promise<ProvisionSecrets> {
	const keysDir = path.join(store.nodeDir(nodeId), 'keys');
	const [hydraSigningKey, cardanoSigningKey] = await Promise.all([
		fs.readFile(path.join(keysDir, 'hydra.sk'), 'utf8'),
		fs.readFile(path.join(keysDir, 'cardano.sk'), 'utf8'),
	]);
	return { hydraSigningKey, cardanoSigningKey };
}

export async function provisionNode(request: ProvisionRequest, deps: ProvisionDeps): Promise<ProvisionResult> {
	if (request.idempotencyKey.trim().length === 0) {
		throw new ProvisionError('an Idempotency-Key header is required so a lost response can be retried safely', 400);
	}

	// The scan below deliberately uses the strict listing, which throws on a
	// damaged record. Failing closed is correct here: if we cannot read every
	// record we cannot prove this idempotency key is unused, and guessing would
	// double-allocate a node and its port.
	const existing = (await deps.store.list()).find((record) => record.idempotencyKey === request.idempotencyKey);
	if (existing !== undefined) {
		// A replay must be a replay of the *same* request. Silently returning a
		// node provisioned with different periods would leave the caller believing
		// it configured something it did not.
		const mismatched = (
			[
				['network', existing.network, request.network],
				['contestationPeriodSeconds', existing.contestationPeriodSeconds, request.contestationPeriodSeconds],
				['depositPeriodSeconds', existing.depositPeriodSeconds, request.depositPeriodSeconds],
				['unsyncedPeriodSeconds', existing.unsyncedPeriodSeconds, request.unsyncedPeriodSeconds],
			] as const
		).filter(([, stored, requested]) => stored !== requested);

		if (mismatched.length > 0) {
			const fields = mismatched.map(([field]) => field).join(', ');
			throw new ProvisionError(
				`idempotency key ${request.idempotencyKey} was already used with different parameters (${fields}); ` +
					'use a fresh key for a different request',
				409,
			);
		}

		if (!mayDiscloseSecrets(existing)) {
			// Already acknowledged. The node is real, but its keys are sealed.
			return { record: existing, secrets: null, replayed: true };
		}
		return { record: existing, secrets: await readSecrets(deps.store, existing.nodeId), replayed: true };
	}

	const nodeId = deps.newNodeId();
	const triple = deps.ports.allocate();

	try {
		const nodeDir = await deps.store.ensureLayout(nodeId);
		const keysDir = path.join(nodeDir, 'keys');

		const hydra = generateHydraKeyPair();
		const cardano = generateCardanoKeyPair();

		await Promise.all([
			fs.writeFile(path.join(keysDir, 'hydra.sk'), serializeEnvelope(hydra.signingKey), { mode: 0o600 }),
			fs.writeFile(path.join(keysDir, 'hydra.vk'), serializeEnvelope(hydra.verificationKey), { mode: 0o600 }),
			fs.writeFile(path.join(keysDir, 'cardano.sk'), serializeEnvelope(cardano.signingKey), { mode: 0o600 }),
			fs.writeFile(path.join(keysDir, 'cardano.vk'), serializeEnvelope(cardano.verificationKey), { mode: 0o600 }),
		]);

		const createdAt = deps.now().toISOString();
		const record: NodeRecord = {
			nodeId,
			state: 'PendingEscrow',
			desired: 'Stopped',
			network: request.network,
			apiPort: triple.apiPort,
			peerPort: triple.peerPort,
			monitoringPort: triple.monitoringPort,
			advertise: deps.advertiseFor(triple.peerPort),
			peers: [],
			contestationPeriodSeconds: request.contestationPeriodSeconds,
			depositPeriodSeconds: request.depositPeriodSeconds,
			unsyncedPeriodSeconds: request.unsyncedPeriodSeconds,
			hydraVerificationKey: hydra.verificationKey.cborHex,
			cardanoVerificationKey: cardano.verificationKey.cborHex,
			escrowAckedAt: null,
			idempotencyKey: request.idempotencyKey,
			createdAt,
			updatedAt: createdAt,
			restartCount: 0,
			lastStopUndrained: false,
		};
		await deps.store.write(record);

		return {
			record,
			secrets: {
				hydraSigningKey: serializeEnvelope(hydra.signingKey),
				cardanoSigningKey: serializeEnvelope(cardano.signingKey),
			},
			replayed: false,
		};
	} catch (error) {
		// Never leave key material behind for a node that does not exist, and
		// never leak the port. Cleanup order matters: remove the directory (which
		// holds hydra.sk / cardano.sk) before releasing the slot.
		await deps.store.remove(nodeId).catch(() => undefined);
		deps.ports.release(triple.peerPort);
		throw error;
	}
}

/**
 * Seal the disclosure path and hand the node to the supervisor.
 *
 * The node still does not start until its peers are configured, because
 * `--initial-cluster` is fixed at boot and a node started before the handshake
 * would bootstrap a cluster the counterparty cannot join.
 */
export async function acknowledgeEscrow(nodeId: string, deps: ProvisionDeps): Promise<NodeRecord> {
	const record = await deps.store.read(nodeId);
	if (record === null) {
		throw new ProvisionError(`no such node: ${nodeId}`, 404);
	}
	if (record.escrowAckedAt !== null) {
		// Idempotent: acknowledging twice is not an error, it just does nothing.
		return record;
	}

	const updated = await deps.store.update(nodeId, (current) => ({
		...current,
		state: 'Stopped',
		desired: 'Running',
		escrowAckedAt: deps.now().toISOString(),
	}));
	if (updated === null) {
		throw new ProvisionError(`no such node: ${nodeId}`, 404);
	}
	return updated;
}

/**
 * Set the counterparty's peers. Only permitted while the node is stopped: the
 * peer set becomes etcd's `--initial-cluster`, which is fixed at process start.
 */
export async function setPeers(nodeId: string, peers: PeerRecord[], deps: ProvisionDeps): Promise<NodeRecord> {
	// Enforced, not merely documented: the peer set becomes --initial-cluster,
	// which is fixed at process start and determines the content-addressed etcd
	// data directory.
	const record = await requireQuiescentForPeerChange(deps.store, nodeId);
	if (peers.length === 0) {
		throw new ProvisionError('at least one peer is required', 400);
	}
	if (peers.some((peer) => peer.advertise === record.advertise)) {
		throw new ProvisionError('a node cannot list its own advertise address as a peer', 400);
	}
	if (new Set(peers.map((peer) => peer.advertise)).size !== peers.length) {
		throw new ProvisionError('duplicate peer advertise addresses', 400);
	}

	const nodeDir = deps.store.nodeDir(nodeId);
	const peersDir = path.join(nodeDir, 'peers');
	await fs.mkdir(peersDir, { recursive: true });
	// Clear any files from a previous, larger peer set. They are unreferenced —
	// the launcher only reads indices below the peer count — but leaving stale
	// verification keys on disk is misleading during an incident.
	for (const entry of await fs.readdir(peersDir).catch(() => [])) {
		await fs.rm(path.join(peersDir, entry), { force: true });
	}
	await Promise.all(
		peers.flatMap((peer, index) => [
			fs.writeFile(
				path.join(peersDir, `${index}-hydra.vk`),
				serializeEnvelope({
					type: 'HydraVerificationKey_ed25519',
					description: '',
					cborHex: peer.hydraVerificationKey,
				}),
			),
			fs.writeFile(
				path.join(peersDir, `${index}-cardano.vk`),
				serializeEnvelope({
					type: 'PaymentVerificationKeyShelley_ed25519',
					description: 'Payment Verification Key',
					cborHex: peer.cardanoVerificationKey,
				}),
			),
		]),
	);

	const updated = await deps.store.update(nodeId, (current) => ({ ...current, peers }));
	if (updated === null) {
		throw new ProvisionError(`no such node: ${nodeId}`, 404);
	}
	return updated;
}
