/**
 * The executor, driven over a real registry on a temp volume.
 *
 * Everything here turns on one question the supervisor has to answer without a
 * child-process handle: is this node still running? A host restart loses the
 * handles but not the nodes, so the answer comes from a recorded pid and an API
 * probe — and getting it wrong is not a missed observation, it is a SIGKILL
 * sent to whatever else now holds that number.
 *
 * The nodes here are ordinary sleeping processes carrying a `--persistence-dir`
 * argument, which is exactly what distinguishes one real hydra-node from
 * another on the same host. Nothing listens on the API ports, so every probe
 * fails fast with a connection refusal — which is the "the node is gone" case
 * these tests are about.
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadHostConfig, type EnvSource } from '../config.js';
import { PortAllocator } from '../registry/ports.js';
import { NodeRegistryStore } from '../registry/store.js';
import type { NodeRecord } from '../registry/types.js';
import { resolveSlotConfig } from '../slot-config.js';
import { Supervisor } from './supervisor.js';

const env: EnvSource = {
	get: (key) =>
		({
			HYDRA_HOST_PUBLIC_HOST: 'hydra1.example.com',
			HYDRA_HOST_ADMIN_TOKEN: 'a'.repeat(40),
			HYDRA_HOST_USER_TOKEN: 'u'.repeat(40),
			HYDRA_HOST_PEER_PORT_COUNT: '4',
		})[key],
};

const spawned: ChildProcess[] = [];
let dataDir: string;
let store: NodeRegistryStore;
let supervisor: Supervisor;

/**
 * A process that looks like a node serving `nodeDir`.
 *
 * `process.execPath` stands in for the hydra-node binary, and the directory is
 * carried the same way the real argv carries it.
 */
function spawnNodeLike(nodeDir: string): ChildProcess {
	const child = spawn(
		process.execPath,
		['-e', 'setInterval(() => {}, 1000)', '--', '--persistence-dir', path.join(nodeDir, 'persistence')],
		{ stdio: 'ignore' },
	);
	spawned.push(child);
	return child;
}

function makeRecord(overrides: Partial<NodeRecord> = {}): NodeRecord {
	const now = new Date().toISOString();
	return {
		nodeId: 'node-1',
		state: 'Running',
		desired: 'Running',
		network: 'preprod',
		// Nothing listens here, so every probe fails immediately.
		apiPort: 4599,
		peerPort: 5599,
		monitoringPort: 6599,
		advertise: 'hydra1.example.com:5599',
		// Empty on purpose unless a test says otherwise: a node with no peers is
		// never started, which keeps a spawn out of tests that are not about one.
		peers: [],
		contestationPeriodSeconds: 120,
		depositPeriodSeconds: 600,
		unsyncedPeriodSeconds: 300,
		hydraVerificationKey: `5820${'ab'.repeat(32)}`,
		cardanoVerificationKey: `5820${'cd'.repeat(32)}`,
		escrowAckedAt: now,
		idempotencyKey: 'idem-1',
		createdAt: now,
		updatedAt: now,
		startAttempts: 0,
		lastStopUndrained: false,
		...overrides,
	};
}

const silentLogger = {
	info: () => undefined,
	warn: () => undefined,
	error: () => undefined,
};

beforeEach(async () => {
	dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hydra-host-supervisor-'));
	// The binary a fake node is spawned from, so the pid check can be exercised
	// for real rather than mocked. Everything it does — read the command line,
	// match the binary and the node's own directory — is the operating system's
	// behaviour, and a mock would assert our idea of it instead.
	const config = { ...loadHostConfig(env), dataDir, hydraNodeBin: process.execPath };
	store = new NodeRegistryStore(dataDir);
	supervisor = new Supervisor(
		config,
		store,
		new PortAllocator(config.ports),
		resolveSlotConfig('preprod'),
		silentLogger,
	);
});

afterEach(async () => {
	for (const child of spawned.splice(0)) {
		child.kill('SIGKILL');
	}
	await fs.rm(dataDir, { recursive: true, force: true });
});

describe('Supervisor boot', () => {
	// A node opens its API only once etcd has quorum and its chain follower has
	// synced, which with two participants takes minutes. Reading that silence as
	// death erased the pid, and the pid is the only evidence a host restart
	// leaves behind that the process survived it.
	it('keeps a node that is not answering yet but whose own process is still running', async () => {
		const record = makeRecord({ state: 'Starting' });
		await store.write(record);
		const child = spawnNodeLike(store.nodeDir(record.nodeId));
		await store.update(record.nodeId, (current) => ({ ...current, pid: child.pid }));

		await supervisor.boot();

		const after = await store.read(record.nodeId);
		expect(after?.pid).toBe(child.pid);
		expect(after?.state).toBe('Starting');
		// Nothing stopped it, so nothing to unwedge on the way up.
		expect(after?.lastStopUndrained).toBe(false);
		// And no second hydra-node was launched over its directory and ports.
		expect(after?.startAttempts).toBe(0);
	});

	// The pid can only be written once the spawn returns, so a host that died in
	// that window left a live node with nothing naming it. Reading the missing
	// pid as "it never came up" started a second hydra-node over the first one's
	// persistence directory, api port and etcd data dir.
	it('takes back a running node that no record names', async () => {
		const record = makeRecord({ state: 'Starting' });
		await store.write(record);
		const child = spawnNodeLike(store.nodeDir(record.nodeId));

		await supervisor.boot();

		const after = await store.read(record.nodeId);
		expect(after?.pid).toBe(child.pid);
		expect(after?.state).toBe('Starting');
		expect(after?.startAttempts).toBe(0);
	});

	// The case the pid check is there to still allow: the host died and took the
	// node with it. Nothing drained that stop.
	it('records a node whose process is really gone as an undrained stop', async () => {
		const record = makeRecord({ pid: 999_999 });
		await store.write(record);

		await supervisor.boot();

		const after = await store.read(record.nodeId);
		expect(after?.state).toBe('Stopped');
		expect(after?.lastStopUndrained).toBe(true);
		expect(after?.pid).toBeUndefined();
	});

	// Removal begins with a stop, and the stop overwrites `Removing` with
	// `Draining` and then `Stopped` — a window that lasts the whole drain
	// timeout. A host restart inside it used to resume a node the operator had
	// been told (202) was going away, keeping its directory and peer port for
	// good.
	it('finishes a removal that a restart interrupted', async () => {
		const record = makeRecord({ state: 'Stopped', removalRequested: true });
		await store.write(record);

		await supervisor.boot();

		expect(await store.read(record.nodeId)).toBeNull();
	});
});

describe('Supervisor observation', () => {
	// One slow probe is not evidence that a node is gone, and the action taken on
	// that evidence is a spawn — a second hydra-node over the first one's
	// persistence directory, api port and etcd data dir. A live pid running this
	// node settles it.
	it('keeps a node whose own process is still running but is not yet answering', async () => {
		const record = makeRecord();
		await store.write(record);
		const child = spawnNodeLike(store.nodeDir(record.nodeId));
		await store.update(record.nodeId, (current) => ({ ...current, pid: child.pid }));

		await supervisor.tick();

		const after = await store.read(record.nodeId);
		expect(after?.state).toBe('Running');
		expect(after?.pid).toBe(child.pid);
		expect(after?.lastStopUndrained).toBe(false);
	});

	// One host runs a hydra-node per head, so a stale pid matches a sibling's
	// live process just as easily as its own. Believing it would report this node
	// as up because its neighbour is — and later send the neighbour a SIGKILL in
	// this node's name.
	it('refuses a pid that belongs to a different node, and forgets it', async () => {
		const record = makeRecord();
		await store.write(record);
		// Alive, same binary, wrong directory: the neighbour.
		const sibling = spawnNodeLike(path.join(dataDir, 'nodes', 'node-2'));
		await store.update(record.nodeId, (current) => ({ ...current, pid: sibling.pid }));

		await supervisor.tick();

		const after = await store.read(record.nodeId);
		expect(after?.state).toBe('Stopped');
		// Nothing drained it, so the unwedge check must look at it on the way up.
		expect(after?.lastStopUndrained).toBe(true);
		// And the pid is gone, so no later stop can reach for the neighbour again.
		expect(after?.pid).toBeUndefined();
		// The sibling is untouched — the assertion the SIGKILL risk comes down to.
		expect(sibling.killed).toBe(false);
		expect(sibling.exitCode).toBeNull();
	});

	// An adopted node has no exit handler, so nothing reports its death. Left
	// unrecorded, the next start skips the unwedge check for exactly the nodes
	// most likely to be carrying a stranded round.
	it('records an unobserved death as an undrained stop', async () => {
		const record = makeRecord({ pid: 999_999 });
		await store.write(record);

		await supervisor.tick();

		const after = await store.read(record.nodeId);
		expect(after?.state).toBe('Stopped');
		expect(after?.lastStopUndrained).toBe(true);
		expect(after?.pid).toBeUndefined();
	});

	// A node that is up but behind and closing the gap is the catch-up loop
	// working. Refusing the refund there left a node that had been serving for
	// hours one crash away from Failed with no retry left.
	it('leaves a stopped node alone once a shutdown has begun', async () => {
		const record = makeRecord({
			state: 'Stopped',
			lastStopUndrained: false,
			// Peers present, so the plan would otherwise ask for a start.
			peers: [
				{
					advertise: 'hydra2.example.com:5001',
					hydraVerificationKey: `5820${'ef'.repeat(32)}`,
					cardanoVerificationKey: `5820${'12'.repeat(32)}`,
				},
			],
		});
		await store.write(record);

		await supervisor.shutdown();
		await supervisor.tick();

		const after = await store.read(record.nodeId);
		// `start` counts the attempt before it spawns, so an untouched counter is
		// proof no spawn was attempted.
		expect(after?.startAttempts).toBe(0);
		expect(after?.state).toBe('Stopped');
	});
});
