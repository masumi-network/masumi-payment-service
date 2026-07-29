import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NodeRegistryStore, RegistryError } from './store.js';
import type { NodeRecord } from './types.js';

function record(overrides: Partial<NodeRecord> = {}): NodeRecord {
	return {
		nodeId: 'node-1',
		state: 'PendingEscrow',
		desired: 'Stopped',
		network: 'preprod',
		apiPort: 4001,
		peerPort: 5001,
		monitoringPort: 6001,
		advertise: 'hydra1.example.com:5001',
		peers: [],
		contestationPeriodSeconds: 220,
		depositPeriodSeconds: 300,
		unsyncedPeriodSeconds: 1800,
		hydraVerificationKey: '5820aa',
		cardanoVerificationKey: 'bb'.repeat(28),
		escrowAckedAt: null,
		idempotencyKey: 'idem-1',
		createdAt: '2026-07-28T00:00:00.000Z',
		updatedAt: '2026-07-28T00:00:00.000Z',
		restartCount: 0,
		lastStopUndrained: false,
		...overrides,
	};
}

let dataDir: string;
let store: NodeRegistryStore;

beforeEach(async () => {
	dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hydra-host-store-'));
	store = new NodeRegistryStore(dataDir);
});

afterEach(async () => {
	await fs.rm(dataDir, { recursive: true, force: true });
});

describe('NodeRegistryStore', () => {
	it('round-trips a record', async () => {
		await store.write(record());
		const loaded = await store.read('node-1');
		expect(loaded?.nodeId).toBe('node-1');
		expect(loaded?.peerPort).toBe(5001);
		expect(loaded?.advertise).toBe('hydra1.example.com:5001');
	});

	it('returns null for an unknown node rather than throwing', async () => {
		expect(await store.read('missing')).toBeNull();
	});

	it('lists nothing before any node exists', async () => {
		expect(await store.list()).toEqual([]);
	});

	it('lists every record so port allocation can be rebuilt at boot', async () => {
		await store.write(record({ nodeId: 'node-1', peerPort: 5001 }));
		await store.write(record({ nodeId: 'node-2', peerPort: 5002 }));

		const ports = (await store.list()).map((r) => r.peerPort).sort();
		expect(ports).toEqual([5001, 5002]);
	});

	it('leaves no partial file behind when writing', async () => {
		await store.write(record());
		const entries = await fs.readdir(store.nodeDir('node-1'));
		// The temp file used for the atomic rename must not survive.
		expect(entries.filter((e) => e.includes('.tmp'))).toEqual([]);
		expect(entries).toContain('node.json');
	});

	it('overwrites in place without losing the record', async () => {
		await store.write(record());
		await store.write(record({ state: 'Running', desired: 'Running', escrowAckedAt: '2026-07-28T01:00:00.000Z' }));

		const loaded = await store.read('node-1');
		expect(loaded?.state).toBe('Running');
		expect(loaded?.escrowAckedAt).toBe('2026-07-28T01:00:00.000Z');
	});

	it('stamps updatedAt on write', async () => {
		await store.write(record({ updatedAt: '2000-01-01T00:00:00.000Z' }));
		const loaded = await store.read('node-1');
		expect(loaded?.updatedAt).not.toBe('2000-01-01T00:00:00.000Z');
	});

	// A damaged record must be loud: the caller rebuilds port allocation from
	// these files, and silently skipping one would let a live node's peer port
	// be reissued to a new node.
	it('surfaces a damaged record instead of skipping it', async () => {
		await store.write(record());
		await fs.writeFile(path.join(store.nodeDir('node-1'), 'node.json'), '{ not json', 'utf8');

		await expect(store.read('node-1')).rejects.toThrow(RegistryError);
		await expect(store.list()).rejects.toThrow(/not valid JSON/);
	});

	it('rejects a record missing the fields allocation depends on', async () => {
		await store.write(record());
		await fs.writeFile(path.join(store.nodeDir('node-1'), 'node.json'), JSON.stringify({ nodeId: 'node-1' }), 'utf8');
		await expect(store.read('node-1')).rejects.toThrow(/missing a usable peerPort/);
	});

	it('refuses a nodeId that would escape the nodes directory', () => {
		expect(() => store.nodeDir('../escape')).toThrow(RegistryError);
		expect(() => store.nodeDir('a/b')).toThrow(RegistryError);
		expect(() => store.nodeDir('')).toThrow(RegistryError);
	});

	it('creates the key, persistence and peer directories', async () => {
		const dir = await store.ensureLayout('node-1');
		for (const sub of ['keys', 'persistence', 'peers']) {
			await expect(fs.stat(path.join(dir, sub))).resolves.toBeDefined();
		}
	});

	it('removes a node directory entirely', async () => {
		await store.ensureLayout('node-1');
		await store.write(record());
		await store.remove('node-1');

		expect(await store.read('node-1')).toBeNull();
		expect(await store.list()).toEqual([]);
	});
});

describe('NodeRegistryStore.update', () => {
	it('applies a mutator to the record as it is on disk', async () => {
		await store.write(record());
		const updated = await store.update('node-1', (current) => ({ ...current, state: 'Running' }));

		expect(updated?.state).toBe('Running');
		expect((await store.read('node-1'))?.state).toBe('Running');
	});

	// This is the whole point of update(): a caller holding a snapshot captured
	// before someone else's write must not be able to resurrect the stale value.
	it('does not let a caller persist a stale snapshot', async () => {
		await store.write(record());
		const stale = await store.read('node-1');

		// Someone else records an undrained stop.
		await store.update('node-1', (current) => ({ ...current, lastStopUndrained: true }));

		// The holder of the stale snapshot now updates a different field.
		await store.update('node-1', (current) => ({ ...current, state: 'Running' }));

		const final = await store.read('node-1');
		expect(final?.state).toBe('Running');
		expect(final?.lastStopUndrained).toBe(true);
		expect(stale?.lastStopUndrained).toBe(false);
	});

	it('returns null for a node that no longer exists', async () => {
		expect(await store.update('missing', (current) => current)).toBeNull();
	});

	it('refuses a mutator that rewrites nodeId', async () => {
		await store.write(record());
		await expect(store.update('node-1', (current) => ({ ...current, nodeId: 'node-2' }))).rejects.toThrow(
			/may not change nodeId/,
		);
	});
});
