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
		startAttempts: 0,
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

describe('NodeRegistryStore legacy records', () => {
	/**
	 * A Host upgraded in place reads records written under the old field name.
	 * Leaving `startAttempts` undefined would make every arithmetic on it NaN,
	 * and `NaN >= maxStartAttempts` is false — so a node that genuinely could not
	 * start would retry forever instead of being marked Failed.
	 */
	it('carries a pre-rename restartCount across as startAttempts', async () => {
		const legacy = { ...record(), restartCount: 3 } as unknown as Record<string, unknown>;
		delete legacy.startAttempts;

		const nodeDir = path.join(dataDir, 'nodes', 'node-1');
		await fs.mkdir(nodeDir, { recursive: true });
		await fs.writeFile(path.join(nodeDir, 'node.json'), JSON.stringify(legacy), 'utf8');

		expect((await store.read('node-1'))?.startAttempts).toBe(3);
	});

	it('defaults to zero when neither name is present', async () => {
		const legacy = { ...record() } as unknown as Record<string, unknown>;
		delete legacy.startAttempts;

		const nodeDir = path.join(dataDir, 'nodes', 'node-2');
		await fs.mkdir(nodeDir, { recursive: true });
		await fs.writeFile(path.join(nodeDir, 'node.json'), JSON.stringify({ ...legacy, nodeId: 'node-2' }), 'utf8');

		expect((await store.read('node-2'))?.startAttempts).toBe(0);
	});
});

describe('NodeRegistryStore concurrency', () => {
	// Found by running a real host: a node exited while its state was being
	// reconciled, both writers used the same temp filename, and the second
	// rename failed with ENOENT — losing that update.
	it('survives many concurrent updates without a rename race', async () => {
		await store.write(record());

		const results = await Promise.all(
			Array.from({ length: 40 }, (_unused, index) =>
				store.update('node-1', (current) => ({
					...current,
					startAttempts: current.startAttempts + 1,
					apiPort: 4001 + index,
				})),
			),
		);

		expect(results.every((result) => result !== null)).toBe(true);
		// Every increment must be visible: a lost update would leave this short.
		expect((await store.read('node-1'))?.startAttempts).toBe(40);
	});

	// The lock a caller with side effects of its own needs. `setPeers` authorises
	// a peer change, writes every key file, prunes the leftovers and only then
	// updates the record; while the queue covered the record write alone, a start
	// could claim the node in the middle — reading the OLD peer list and launching
	// against the NEW key files, which fixes `--initial-cluster` on a cluster that
	// never reaches quorum and a node that is then planned Idle forever.
	it('holds the node queue for as long as an awaiting mutator runs', async () => {
		await store.write(record());
		const order: string[] = [];

		const slow = store.updateAsync('node-1', async (current) => {
			order.push('slow-start');
			await new Promise((resolve) => setTimeout(resolve, 50));
			order.push('slow-end');
			return { ...current, desired: 'Stopped' };
		});
		const claim = store.update('node-1', (current) => {
			order.push('claim');
			return { ...current, state: 'Starting' };
		});
		await Promise.all([slow, claim]);

		expect(order).toEqual(['slow-start', 'slow-end', 'claim']);
		const final = await store.read('node-1');
		expect(final?.desired).toBe('Stopped');
		expect(final?.state).toBe('Starting');
	});

	// The two writers in the observed failure were doing different things, so
	// the danger is not just a rename clash but one update discarding the other.
	it('does not let concurrent updates discard each other', async () => {
		await store.write(record());

		await Promise.all([
			store.update('node-1', (current) => ({ ...current, lastStopUndrained: true })),
			store.update('node-1', (current) => ({ ...current, state: 'Running' })),
			store.update('node-1', (current) => ({ ...current, desired: 'Running' })),
		]);

		const final = await store.read('node-1');
		expect(final?.lastStopUndrained).toBe(true);
		expect(final?.state).toBe('Running');
		expect(final?.desired).toBe('Running');
	});

	it('leaves no temp files behind after concurrent writes', async () => {
		await store.write(record());
		await Promise.all(Array.from({ length: 20 }, () => store.update('node-1', (current) => ({ ...current }))));
		const entries = await fs.readdir(store.nodeDir('node-1'));
		expect(entries.filter((entry) => entry.includes('.tmp'))).toEqual([]);
	});

	it('keeps one failing update from cascading into the others', async () => {
		await store.write(record());
		const outcomes = await Promise.allSettled([
			store.update('node-1', (current) => ({ ...current, nodeId: 'hijacked' })),
			store.update('node-1', (current) => ({ ...current, startAttempts: 7 })),
		]);

		expect(outcomes[0]?.status).toBe('rejected');
		expect(outcomes[1]?.status).toBe('fulfilled');
		expect((await store.read('node-1'))?.startAttempts).toBe(7);
	});
});

// update() is serialised, so the shared-temp-name race is unreachable through
// it. write() is public and has no queue, so it still needs a unique temp name.
describe('NodeRegistryStore.write concurrency', () => {
	it('tolerates concurrent direct writes', async () => {
		await store.write(record());
		await expect(
			Promise.all(Array.from({ length: 25 }, (_unused, i) => store.write(record({ startAttempts: i })))),
		).resolves.toBeDefined();

		const entries = await fs.readdir(store.nodeDir('node-1'));
		expect(entries.filter((entry) => entry.includes('.tmp'))).toEqual([]);
		expect(await store.read('node-1')).not.toBeNull();
	});
});
