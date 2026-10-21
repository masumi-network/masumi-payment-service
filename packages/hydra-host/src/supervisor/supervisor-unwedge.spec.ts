/**
 * What the supervisor does with a stranded round it may not repair itself.
 *
 * `unwedgeNode` is replaced so the test does not sit through its 30s settle
 * wait; its own decisions are covered in unwedge.spec.ts. Everything else is
 * real: the registry on a temp volume, a node-like process for the pid check,
 * and an HTTP server that answers the node's API probes.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { UnwedgeOptions, UnwedgeOutcome } from './unwedge.js';

const mockUnwedgeNode = jest.fn<(options: UnwedgeOptions) => Promise<UnwedgeOutcome>>();
jest.unstable_mockModule('./unwedge.js', () => ({ unwedgeNode: mockUnwedgeNode }));

const { loadHostConfig } = await import('../config.js');
const { PortAllocator } = await import('../registry/ports.js');
const { NodeRegistryStore } = await import('../registry/store.js');
const { resolveSlotConfig } = await import('../slot-config.js');
const { Supervisor } = await import('./supervisor.js');

const env = {
	get: (key: string) =>
		({
			HYDRA_HOST_PUBLIC_HOST: 'hydra1.example.com',
			HYDRA_HOST_PUBLIC_EXCHANGE_URL: 'https://exchange.hydra1.example.com:8444/exchange',
			HYDRA_HOST_ADMIN_TOKEN: 'a'.repeat(40),
			HYDRA_HOST_USER_TOKEN: 'u'.repeat(40),
			HYDRA_HOST_PEER_PORT_COUNT: '4',
		})[key],
};

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

let dataDir: string;
let child: ChildProcess | undefined;
let server: Server | undefined;

beforeEach(async () => {
	dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hydra-host-supervisor-unwedge-'));
	mockUnwedgeNode.mockReset();
});

afterEach(async () => {
	child?.kill('SIGKILL');
	child = undefined;
	if (server) {
		const closing = server;
		await new Promise<void>((resolve) => closing.close(() => resolve()));
		server = undefined;
	}
	await fs.rm(dataDir, { recursive: true, force: true });
});

/** Answers every probe, so the node counts as up and the plan reaches `Unwedge`. */
async function serveNodeApi(): Promise<number> {
	const listening = createServer((_request, response) => {
		response.writeHead(200, { 'Content-Type': 'application/json' });
		response.end(JSON.stringify({ tag: 'SeenSnapshot' }));
	});
	server = listening;
	await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve));
	return (listening.address() as AddressInfo).port;
}

describe('Supervisor with a stranded round that needs an operator', () => {
	// The node must stay up: a Failed node is stopped, and a stopped node cannot
	// contest a close. The reason must still reach the API, and the check must not
	// run again on every tick.
	it('keeps the node running, records the reason, and does not check again', async () => {
		const config = { ...loadHostConfig(env), dataDir, hydraNodeBin: process.execPath };
		const store = new NodeRegistryStore(dataDir);
		const supervisor = new Supervisor(
			config,
			store,
			new PortAllocator(config.ports),
			resolveSlotConfig('preprod'),
			silentLogger,
		);
		const now = new Date().toISOString();
		const nodeId = 'node-1';
		child = spawn(
			process.execPath,
			['-e', 'setInterval(() => {}, 1000)', '--', '--persistence-dir', path.join(store.nodeDir(nodeId), 'persistence')],
			{ stdio: 'ignore' },
		);
		await store.write({
			nodeId,
			state: 'Running',
			desired: 'Running',
			network: 'preprod',
			apiPort: await serveNodeApi(),
			peerPort: 5599,
			monitoringPort: 6599,
			advertise: 'hydra1.example.com:5599',
			// A node without peers is never planned past Idle.
			peers: [
				{
					advertise: 'hydra2.example.com:5001',
					hydraVerificationKey: `5820${'ef'.repeat(32)}`,
					cardanoVerificationKey: `5820${'12'.repeat(32)}`,
				},
			],
			contestationPeriodSeconds: 120,
			depositPeriodSeconds: 600,
			depositActivationSeconds: 600,
			unsyncedPeriodSeconds: 300,
			hydraVerificationKey: `5820${'ab'.repeat(32)}`,
			cardanoVerificationKey: `5820${'cd'.repeat(32)}`,
			escrowAckedAt: now,
			idempotencyKey: 'idem-1',
			createdAt: now,
			updatedAt: now,
			startAttempts: 1,
			lastStopUndrained: true,
			pid: child.pid,
		});
		mockUnwedgeNode.mockResolvedValue({ kind: 'NeedsOperator', tag: 'SeenSnapshot', reason: 'stranded round' });

		await supervisor.tick();

		expect(mockUnwedgeNode).toHaveBeenCalledTimes(1);
		expect(mockUnwedgeNode.mock.calls[0]?.[0].allowAutoSideLoad).toBe(false);
		const after = await store.read(nodeId);
		expect(after?.state).toBe('Running');
		expect(after?.failureReason).toMatch(/^stranded round \(seen \d{4}-/);
		expect(after?.lastStopUndrained).toBe(false);
		expect(child.exitCode).toBeNull();

		await supervisor.tick();

		expect(mockUnwedgeNode).toHaveBeenCalledTimes(1);
		expect((await store.read(nodeId))?.failureReason).toBe(after?.failureReason);
	}, 30_000);
});
