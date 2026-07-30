import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PortAllocator } from '../registry/ports.js';
import { NodeRegistryStore } from '../registry/store.js';
import { acknowledgeEscrow, mayDiscloseSecrets, provisionNode, setPeers, type ProvisionDeps } from './provision.js';

const LAYOUT = { peerStart: 5001, apiStart: 4001, monitoringStart: 6001, capacity: 4 };
const REQUEST = {
	idempotencyKey: 'idem-1',
	network: 'preprod' as const,
	contestationPeriodSeconds: 220,
	depositPeriodSeconds: 300,
	unsyncedPeriodSeconds: 1800,
};

let dataDir: string;
let deps: ProvisionDeps;
let counter: number;

beforeEach(async () => {
	dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hydra-host-provision-'));
	counter = 0;
	deps = {
		store: new NodeRegistryStore(dataDir),
		ports: new PortAllocator(LAYOUT),
		advertiseFor: (peerPort) => `hydra1.example.com:${peerPort}`,
		newNodeId: () => `node-${++counter}`,
		now: () => new Date('2026-07-28T12:00:00.000Z'),
	};
});

afterEach(async () => {
	await fs.rm(dataDir, { recursive: true, force: true });
});

describe('provisionNode', () => {
	it('creates an un-started node and discloses its keys once', async () => {
		const result = await provisionNode(REQUEST, deps);

		expect(result.record.state).toBe('PendingEscrow');
		// Must not be running: the payment service has not confirmed it holds the keys.
		expect(result.record.desired).toBe('Stopped');
		expect(result.record.peers).toEqual([]);
		expect(result.secrets?.hydraSigningKey).toContain('HydraSigningKey_ed25519');
		expect(result.secrets?.cardanoSigningKey).toContain('PaymentSigningKeyShelley_ed25519');
		expect(result.replayed).toBe(false);
	});

	it('allocates an aligned port triple and derives the advertise address', async () => {
		const result = await provisionNode(REQUEST, deps);
		expect(result.record.peerPort).toBe(5001);
		expect(result.record.advertise).toBe('hydra1.example.com:5001');
	});

	it('writes key files with owner-only permissions', async () => {
		const result = await provisionNode(REQUEST, deps);
		const keysDir = path.join(deps.store.nodeDir(result.record.nodeId), 'keys');
		for (const file of ['hydra.sk', 'cardano.sk', 'hydra.vk', 'cardano.vk']) {
			const stat = await fs.stat(path.join(keysDir, file));
			expect(stat.mode & 0o077).toBe(0);
		}
	});

	it('returns public material on the record but keeps signing keys out of it', async () => {
		const { record } = await provisionNode(REQUEST, deps);
		expect(record.hydraVerificationKey).toMatch(/^5820[0-9a-f]{64}$/);
		expect(record.cardanoVerificationKey).toMatch(/^5820[0-9a-f]{64}$/);
		expect(JSON.stringify(record)).not.toContain('SigningKey');
	});

	// The lost-response case: without this, a dropped reply would leave a node
	// whose keys exist only on the Host.
	it('replays the same node and the same secrets for a repeated idempotency key', async () => {
		const first = await provisionNode(REQUEST, deps);
		const second = await provisionNode(REQUEST, deps);

		expect(second.replayed).toBe(true);
		expect(second.record.nodeId).toBe(first.record.nodeId);
		expect(second.secrets).toEqual(first.secrets);
		expect(deps.ports.used).toBe(1);
	});

	it('allocates a distinct node for a distinct idempotency key', async () => {
		const first = await provisionNode(REQUEST, deps);
		const second = await provisionNode({ ...REQUEST, idempotencyKey: 'idem-2' }, deps);

		expect(second.record.nodeId).not.toBe(first.record.nodeId);
		expect(second.record.peerPort).toBe(5002);
	});

	it('requires an idempotency key', async () => {
		await expect(provisionNode({ ...REQUEST, idempotencyKey: '  ' }, deps)).rejects.toThrow(/Idempotency-Key/);
	});

	it('does not leak a port when provisioning fails', async () => {
		const failing: ProvisionDeps = {
			...deps,
			newNodeId: () => {
				throw new Error('boom');
			},
		};
		// newNodeId throws before allocation, so nothing is taken.
		await expect(provisionNode(REQUEST, failing)).rejects.toThrow('boom');
		expect(deps.ports.used).toBe(0);
	});

	it('refuses once every slot is in use', async () => {
		for (let i = 0; i < LAYOUT.capacity; i++) {
			await provisionNode({ ...REQUEST, idempotencyKey: `idem-${i}` }, deps);
		}
		await expect(provisionNode({ ...REQUEST, idempotencyKey: 'one-too-many' }, deps)).rejects.toThrow(
			/add another host/,
		);
	});
});

describe('acknowledgeEscrow', () => {
	it('seals disclosure and hands the node to the supervisor', async () => {
		const { record } = await provisionNode(REQUEST, deps);
		const acked = await acknowledgeEscrow(record.nodeId, deps);

		expect(acked.escrowAckedAt).not.toBeNull();
		expect(acked.state).toBe('Stopped');
		expect(acked.desired).toBe('Running');
		expect(mayDiscloseSecrets(acked)).toBe(false);
	});

	// After acknowledgement the keys are sealed: a replayed provision returns the
	// node but never the material again.
	it('stops a replayed provision from returning secrets', async () => {
		const { record } = await provisionNode(REQUEST, deps);
		await acknowledgeEscrow(record.nodeId, deps);

		const replay = await provisionNode(REQUEST, deps);
		expect(replay.replayed).toBe(true);
		expect(replay.secrets).toBeNull();
	});

	it('is idempotent', async () => {
		const { record } = await provisionNode(REQUEST, deps);
		const first = await acknowledgeEscrow(record.nodeId, deps);
		const second = await acknowledgeEscrow(record.nodeId, deps);
		expect(second.escrowAckedAt).toBe(first.escrowAckedAt);
	});

	it('404s for an unknown node', async () => {
		await expect(acknowledgeEscrow('missing', deps)).rejects.toMatchObject({ status: 404 });
	});
});

describe('setPeers', () => {
	const peer = {
		advertise: 'hydra2.example.com:5001',
		hydraVerificationKey: `5820${'ab'.repeat(32)}`,
		cardanoVerificationKey: `5820${'cd'.repeat(32)}`,
	};

	it('records peers and writes their verification key files', async () => {
		const { record } = await provisionNode(REQUEST, deps);
		const updated = await setPeers(record.nodeId, [peer], deps);

		expect(updated.peers).toEqual([peer]);
		const peersDir = path.join(deps.store.nodeDir(record.nodeId), 'peers');
		await expect(fs.readFile(path.join(peersDir, '0-hydra.vk'), 'utf8')).resolves.toContain(
			'HydraVerificationKey_ed25519',
		);
		await expect(fs.readFile(path.join(peersDir, '0-cardano.vk'), 'utf8')).resolves.toContain(
			'PaymentVerificationKeyShelley_ed25519',
		);
	});

	it('refuses an empty peer set, self-peering and duplicates', async () => {
		const { record } = await provisionNode(REQUEST, deps);

		await expect(setPeers(record.nodeId, [], deps)).rejects.toThrow(/at least one peer/);
		await expect(setPeers(record.nodeId, [{ ...peer, advertise: record.advertise }], deps)).rejects.toThrow(
			/its own advertise address/,
		);
		await expect(setPeers(record.nodeId, [peer, peer], deps)).rejects.toThrow(/duplicate/);
	});

	it('404s for an unknown node', async () => {
		await expect(setPeers('missing', [peer], deps)).rejects.toMatchObject({ status: 404 });
	});
});
