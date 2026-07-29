import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadHostConfig, type EnvSource } from '../config.js';
import { PortAllocator } from '../registry/ports.js';
import { NodeRegistryStore } from '../registry/store.js';
import type { NodeRecord } from '../registry/types.js';
import type { Supervisor } from '../supervisor/supervisor.js';
import { createControlPlane } from './server.js';
import type { ProvisionDeps } from './provision.js';

const ADMIN = 'a'.repeat(40);
const USER = 'u'.repeat(40);

const env: EnvSource = {
	get: (key) =>
		({
			HYDRA_HOST_PUBLIC_HOST: 'hydra1.example.com',
			HYDRA_HOST_ADMIN_TOKEN: ADMIN,
			HYDRA_HOST_USER_TOKEN: USER,
			HYDRA_HOST_PEER_PORT_COUNT: '4',
		})[key],
};

/** Stands in for a hydra-node API, recording what actually reached it. */
type FakeNode = {
	server: Server;
	port: number;
	received: { url: string; method: string; headers: IncomingMessage['headers'] }[];
};

async function startFakeNode(): Promise<FakeNode> {
	const received: FakeNode['received'] = [];
	const server = createServer((request, response) => {
		received.push({ url: request.url ?? '', method: request.method ?? '', headers: request.headers });
		response.writeHead(200, { 'Content-Type': 'application/json' });
		response.end(JSON.stringify({ ok: true, sawUrl: request.url }));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return { server, port: (server.address() as AddressInfo).port, received };
}

function record(overrides: Partial<NodeRecord>): NodeRecord {
	return {
		nodeId: 'node-1',
		state: 'Running',
		desired: 'Running',
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
		cardanoVerificationKey: '5820bb',
		escrowAckedAt: '2026-07-28T11:00:00.000Z',
		idempotencyKey: 'idem-1',
		createdAt: '2026-07-28T11:00:00.000Z',
		updatedAt: '2026-07-28T11:00:00.000Z',
		restartCount: 0,
		lastStopUndrained: false,
		...overrides,
	};
}

let dataDir: string;
let store: NodeRegistryStore;
let host: Server;
let baseUrl: string;
let node: FakeNode;

beforeEach(async () => {
	dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hydra-host-proxy-'));
	node = await startFakeNode();
	store = new NodeRegistryStore(dataDir);
	await store.write(record({ apiPort: node.port }));

	const config = { ...loadHostConfig(env), dataDir };
	const ports = new PortAllocator(config.ports);
	host = createControlPlane({
		config,
		store,
		ports,
		supervisor: { tick: async () => undefined } as unknown as Supervisor,
		provision: {
			store,
			ports,
			advertiseFor: (p) => `hydra1.example.com:${p}`,
			newNodeId: () => 'node-x',
			now: () => new Date(),
		} as ProvisionDeps,
		logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
	});
	await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
});

afterEach(async () => {
	await new Promise<void>((resolve) => host.close(() => resolve()));
	await new Promise<void>((resolve) => node.server.close(() => resolve()));
	await fs.rm(dataDir, { recursive: true, force: true });
});

const call = (method: string, url: string, token?: string): Promise<Response> =>
	fetch(`${baseUrl}${url}`, {
		method,
		headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
	});

describe('node api proxy', () => {
	it('forwards an allowed read to the node', async () => {
		const response = await call('GET', '/v1/nodes/node-1/api/snapshot/utxo', USER);
		expect(response.status).toBe(200);
		expect((await response.json()) as { ok: boolean }).toMatchObject({ ok: true });
		expect(node.received[0]?.url).toBe('/snapshot/utxo');
	});

	// history/snapshot-utxo/address query params drive what the node streams back.
	it('preserves the query string', async () => {
		await call('GET', '/v1/nodes/node-1/api/snapshot?history=no', USER);
		expect(node.received[0]?.url).toBe('/snapshot?history=no');
	});

	// The token authorises us to the Host, not the Host to the node — forwarding
	// it would leave our credential in the node's logs for no benefit.
	it('strips the caller credential before forwarding', async () => {
		await call('GET', '/v1/nodes/node-1/api/head', USER);
		expect(node.received[0]?.headers.authorization).toBeUndefined();
	});

	it('requires a token', async () => {
		expect((await call('GET', '/v1/nodes/node-1/api/head')).status).toBe(401);
		expect(node.received).toHaveLength(0);
	});

	it('accepts the admin token too, since admin is a superset', async () => {
		expect((await call('GET', '/v1/nodes/node-1/api/head', ADMIN)).status).toBe(200);
	});

	// The whole reason the proxy uses an allow-list.
	it('never forwards /config, which discloses key paths', async () => {
		expect((await call('GET', '/v1/nodes/node-1/api/config', USER)).status).toBe(404);
		expect(node.received).toHaveLength(0);
	});

	it('refuses a path outside the allow-list without contacting the node', async () => {
		expect((await call('GET', '/v1/nodes/node-1/api/some-future-endpoint', USER)).status).toBe(404);
		expect((await call('POST', '/v1/nodes/node-1/api/head', USER)).status).toBe(404);
		expect(node.received).toHaveLength(0);
	});

	it('404s an unknown node', async () => {
		expect((await call('GET', '/v1/nodes/node-9/api/head', USER)).status).toBe(404);
	});

	// A connection-refused 502 is far less useful than saying what state it is in.
	it('409s when the node is not running', async () => {
		await store.update('node-1', (current) => ({ ...current, state: 'Stopped' }));
		const response = await call('GET', '/v1/nodes/node-1/api/head', USER);

		expect(response.status).toBe(409);
		expect((await response.json()) as { error: string }).toMatchObject({ error: expect.stringContaining('Stopped') as unknown as string });
	});

	it('502s when the node is recorded running but unreachable', async () => {
		await store.update('node-1', (current) => ({ ...current, apiPort: 1 }));
		expect((await call('GET', '/v1/nodes/node-1/api/head', USER)).status).toBe(502);
	});

	it('does not shadow the control plane', async () => {
		// health is a control-plane route on the same node prefix.
		expect((await call('GET', '/v1/nodes/node-1/health', USER)).status).toBe(200);
	});
});

describe('node api websocket proxy', () => {
	/** Attach a real WebSocket server to the fake node, echoing what it receives. */
	async function upgradeableNode(): Promise<{ server: Server; port: number; greeted: string[] }> {
		const { WebSocketServer } = await import('ws');
		const greeted: string[] = [];
		const server = createServer();
		const wss = new WebSocketServer({ server });
		wss.on('connection', (socket: { send: (d: string) => void; on: (e: string, cb: (d: Buffer) => void) => void }, request: { url?: string }) => {
			greeted.push(request.url ?? '');
			socket.send(JSON.stringify({ tag: 'Greetings' }));
			socket.on('message', (data: Buffer) => socket.send(data.toString()));
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		return { server, port: (server.address() as AddressInfo).port, greeted };
	}

	const connect = async (
		url: string,
		token?: string,
	): Promise<{ firstMessage: string | null; status: number | null }> => {
		const WebSocket = (await import('ws')).default;
		return new Promise((resolve) => {
			const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}${url}`, {
				headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
			} as never);
			const done = (firstMessage: string | null, status: number | null): void => {
				try {
					socket.close();
				} catch {
					// already closed
				}
				resolve({ firstMessage, status });
			};
			socket.on('message', (data: Buffer) => done(data.toString(), null));
			socket.on('unexpected-response', (_req: unknown, res: { statusCode?: number }) =>
				done(null, res.statusCode ?? null),
			);
			socket.on('error', () => done(null, null));
			setTimeout(() => done(null, null), 4000).unref?.();
		});
	};

	it('tunnels a websocket through to the node', async () => {
		const upstream = await upgradeableNode();
		await store.update('node-1', (current) => ({ ...current, apiPort: upstream.port }));

		const result = await connect('/v1/nodes/node-1/api?history=no', USER);

		expect(result.firstMessage).toContain('Greetings');
		// The query string the payment service relies on must survive the tunnel.
		expect(upstream.greeted[0]).toBe('/?history=no');

		await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
	});

	it('rejects an unauthenticated upgrade', async () => {
		const upstream = await upgradeableNode();
		await store.update('node-1', (current) => ({ ...current, apiPort: upstream.port }));

		const result = await connect('/v1/nodes/node-1/api');
		expect(result.status).toBe(401);
		expect(upstream.greeted).toHaveLength(0);

		await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
	});

	it('rejects an upgrade to a node that is not running', async () => {
		const upstream = await upgradeableNode();
		await store.update('node-1', (current) => ({ ...current, apiPort: upstream.port, state: 'Stopped' }));

		expect((await connect('/v1/nodes/node-1/api', USER)).status).toBe(409);

		await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
	});

	it('rejects an upgrade on any path other than the api root', async () => {
		expect((await connect('/v1/nodes/node-1/api/config', USER)).status).toBe(404);
	});
});
