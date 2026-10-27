import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { connect, type AddressInfo, type Socket } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadHostConfig, type EnvSource } from '../config.js';
import { PortAllocator } from '../registry/ports.js';
import { NodeRegistryStore } from '../registry/store.js';
import type { NodeRecord } from '../registry/types.js';
import type { Supervisor } from '../supervisor/supervisor.js';
import { ExchangeStore } from '../registry/exchange-store.js';
import { createControlPlane } from './server.js';
import type { ProvisionDeps } from './provision.js';

const TEST_EXCHANGE_KEY = Buffer.alloc(32, 0x42);

const ADMIN = 'a'.repeat(40);
const USER = 'u'.repeat(40);
/** Long enough that only a hung response reaches it. */
const CALLER_TIMEOUT_MS = 2_000;
/** Long enough that only a node connection that is never released reaches it. */
const NODE_RELEASE_WAIT_MS = 2_000;
/** The proxy's own side of a hang-up can log after the node already saw its socket close. */
const LATE_LOG_WAIT_MS = 100;

const env: EnvSource = {
	get: (key) =>
		({
			HYDRA_HOST_PUBLIC_HOST: 'hydra1.example.com',
			HYDRA_HOST_PUBLIC_EXCHANGE_URL: 'https://exchange.hydra1.example.com:8444/exchange',
			HYDRA_HOST_ADMIN_TOKEN: ADMIN,
			HYDRA_HOST_USER_TOKEN: USER,
			HYDRA_HOST_EXCHANGE_KEY: '42'.repeat(32),
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
		// The node advertises itself as indexable; the control plane must strip
		// this so its own noindex stamp wins on the proxied response.
		response.writeHead(200, { 'Content-Type': 'application/json', 'X-Robots-Tag': 'index' });
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
		depositActivationSeconds: 300,
		unsyncedPeriodSeconds: 1800,
		hydraVerificationKey: '5820aa',
		cardanoVerificationKey: '5820bb',
		escrowAckedAt: '2026-07-28T11:00:00.000Z',
		idempotencyKey: 'idem-1',
		createdAt: '2026-07-28T11:00:00.000Z',
		updatedAt: '2026-07-28T11:00:00.000Z',
		startAttempts: 0,
		lastStopUndrained: false,
		...overrides,
	};
}

let dataDir: string;
let store: NodeRegistryStore;
let host: Server;
let baseUrl: string;
let node: FakeNode;
let tickCalls: number;
let releaseTick: () => void;
let loggedErrors: string[];

beforeEach(async () => {
	loggedErrors = [];
	dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hydra-host-proxy-'));
	node = await startFakeNode();
	store = new NodeRegistryStore(dataDir);
	await store.write(record({ apiPort: node.port }));

	tickCalls = 0;
	const held = new Promise<void>((resolve) => {
		releaseTick = resolve;
	});
	const config = { ...loadHostConfig(env), dataDir };
	const ports = new PortAllocator(config.ports);
	host = createControlPlane({
		config,
		store,
		exchange: new ExchangeStore(dataDir, TEST_EXCHANGE_KEY),
		ports,
		// Held open until afterEach, so the record keeps the state the API left it
		// in: the window between a request and the supervisor acting on it.
		supervisor: {
			tick: () => {
				tickCalls += 1;
				return held;
			},
		} as unknown as Supervisor,
		provision: {
			store,
			ports,
			advertiseFor: (p) => `hydra1.example.com:${p}`,
			checkPeerTarget: async () => null,
			newNodeId: () => 'node-x',
			now: () => new Date(),
		} as ProvisionDeps,
		logger: { info: () => undefined, warn: () => undefined, error: (message) => loggedErrors.push(message) },
	});
	await new Promise<void>((resolve) => host.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(host.address() as AddressInfo).port}`;
});

afterEach(async () => {
	releaseTick();
	await new Promise<void>((resolve) => host.close(() => resolve()));
	await new Promise<void>((resolve) => node.server.close(() => resolve()));
	await fs.rm(dataDir, { recursive: true, force: true });
});

const call = (method: string, url: string, token?: string): Promise<Response> =>
	fetch(`${baseUrl}${url}`, {
		method,
		headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
	});

/**
 * Holds the next `count` node record reads until the control plane has seen
 * that many requests close: a read slow enough that the caller leaves first.
 */
function holdRecordReads(count: number): { allHeld: Promise<void>; allDone: Promise<void> } {
	let release: () => void = () => undefined;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	let closedRequests = 0;
	host.on('request', (request) => {
		request.once('close', () => {
			closedRequests += 1;
			if (closedRequests === count) release();
		});
	});
	let markAllHeld: () => void = () => undefined;
	const allHeld = new Promise<void>((resolve) => {
		markAllHeld = resolve;
	});
	let markAllDone: () => void = () => undefined;
	const allDone = new Promise<void>((resolve) => {
		markAllDone = resolve;
	});
	const readRecord = store.read.bind(store);
	let heldReads = 0;
	let doneReads = 0;
	store.read = async (nodeId) => {
		heldReads += 1;
		if (heldReads === count) {
			store.read = readRecord;
			markAllHeld();
		}
		await released;
		const found = await readRecord(nodeId);
		doneReads += 1;
		if (doneReads === count) markAllDone();
		return found;
	};
	return { allHeld, allDone };
}

describe('node api proxy', () => {
	it('forwards an allowed read to the node', async () => {
		const response = await call('GET', '/v1/nodes/node-1/api/snapshot/utxo', USER);
		expect(response.status).toBe(200);
		expect((await response.json()) as { ok: boolean }).toMatchObject({ ok: true });
		expect(node.received[0]?.url).toBe('/snapshot/utxo');
	});

	// A same-name upstream header would beat the handler's setHeader in
	// writeHead's merge, so the proxy strips the node's x-robots-tag.
	it('keeps proxied responses noindex despite an upstream x-robots-tag', async () => {
		const response = await call('GET', '/v1/nodes/node-1/api/snapshot/utxo', USER);
		expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
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
		expect((await response.json()) as { error: string }).toMatchObject({
			error: expect.stringContaining('Stopped') as unknown as string,
		});
	});

	it('502s when the node is recorded running but unreachable', async () => {
		await store.update('node-1', (current) => ({ ...current, apiPort: 1 }));
		expect((await call('GET', '/v1/nodes/node-1/api/head', USER)).status).toBe(502);
	});

	it('marks a refused node connection as a Host failure before dispatch', async () => {
		await store.update('node-1', (current) => ({ ...current, apiPort: 1 }));
		const response = await call('DELETE', `/v1/nodes/node-1/api/commits/${'a'.repeat(64)}`, USER);

		expect(response.status).toBe(502);
		expect(response.headers.get('x-hydra-host-proxy-error')).toBe('node-not-connected');
		expect(node.received).toHaveLength(0);
	});

	it('does not forward a node-supplied Host failure marker', async () => {
		const spoofing = createServer((_request, response) => {
			response.writeHead(502, { 'X-Hydra-Host-Proxy-Error': 'node-not-connected' });
			response.end('{"error":"node refused"}');
		});
		await new Promise<void>((resolve) => spoofing.listen(0, '127.0.0.1', resolve));
		try {
			await store.update('node-1', (current) => ({ ...current, apiPort: (spoofing.address() as AddressInfo).port }));
			const response = await call('DELETE', `/v1/nodes/node-1/api/commits/${'a'.repeat(64)}`, USER);
			expect(response.status).toBe(502);
			expect(response.headers.get('x-hydra-host-proxy-error')).toBeNull();
		} finally {
			await new Promise<void>((resolve) => spoofing.close(() => resolve()));
		}
	});

	it('does not attest non-dispatch after the node accepted a connection', async () => {
		let received = 0;
		const dropping = createServer((request) => {
			received += 1;
			request.socket.destroy();
		});
		await new Promise<void>((resolve) => dropping.listen(0, '127.0.0.1', resolve));
		try {
			await store.update('node-1', (current) => ({ ...current, apiPort: (dropping.address() as AddressInfo).port }));
			const response = await call('DELETE', `/v1/nodes/node-1/api/commits/${'a'.repeat(64)}`, USER);
			expect(response.status).toBe(502);
			expect(response.headers.get('x-hydra-host-proxy-error')).toBeNull();
			expect(received).toBe(1);
		} finally {
			await new Promise<void>((resolve) => dropping.close(() => resolve()));
		}
	});

	// A clean close fails only the node's response, which pipe() does not pass
	// on, so the caller's 200 stayed open until its own timeout. A reset fails
	// the request too, and its handler appended a JSON error body to the partial
	// one, so the caller read a complete-looking 200.
	it.each([
		['closes', (socket: Socket) => socket.destroy()],
		['resets', (socket: Socket) => socket.resetAndDestroy()],
	])('cuts the caller off when the node %s the connection mid-body', async (_label, drop) => {
		let nodeSocket: Socket | undefined;
		const dropping = createServer((request, response) => {
			nodeSocket = request.socket;
			response.writeHead(200, { 'Content-Type': 'application/json' });
			response.write('{"tag":"Open","contents":');
		});
		await new Promise<void>((resolve) => dropping.listen(0, '127.0.0.1', resolve));
		try {
			const apiPort = (dropping.address() as AddressInfo).port;
			await store.update('node-1', (current) => ({ ...current, apiPort }));
			const response = await fetch(`${baseUrl}/v1/nodes/node-1/api/head`, {
				headers: { Authorization: `Bearer ${USER}` },
				signal: AbortSignal.timeout(CALLER_TIMEOUT_MS),
			});
			// The headers came through the proxy, so the drop lands mid-body.
			expect(nodeSocket).toBeDefined();
			drop(nodeSocket as Socket);
			const bodyError = await response.text().then(
				() => null,
				(error: unknown) => error,
			);
			// fetch's `TypeError: terminated`, not a body read that succeeds or
			// the TimeoutError the hang ended in.
			expect((bodyError as Error | null)?.name).toBe('TypeError');
			// The clean close used to fail without a word in the log.
			expect(loggedErrors).toEqual(expect.arrayContaining([expect.stringContaining(`port ${apiPort} failed`)]));
		} finally {
			// A failed run can leave the proxy's connection open, and close() would
			// wait on it until jest's own timeout hid the real failure.
			dropping.closeAllConnections();
			await new Promise<void>((resolve) => dropping.close(() => resolve()));
		}
	});

	// 'aborted' only covers a request still being read, so a caller that hung
	// up after that left the node's connection open: for good mid-body, and
	// until the node answered when the caller left first.
	it.each([
		['mid-body', true],
		['before the node answers', false],
	])('releases the node connection when the caller hangs up %s', async (_label, isNodeAnswering) => {
		let markNodeReached: () => void = () => undefined;
		const nodeReached = new Promise<void>((resolve) => {
			markNodeReached = resolve;
		});
		let markNodeReleased: () => void = () => undefined;
		const nodeReleased = new Promise<'released'>((resolve) => {
			markNodeReleased = () => resolve('released');
		});
		const streaming = createServer((request, response) => {
			request.socket.once('close', () => markNodeReleased());
			markNodeReached();
			if (isNodeAnswering) {
				response.writeHead(200, { 'Content-Type': 'application/json' });
				response.write('{"tag":"Open","contents":');
			}
		});
		await new Promise<void>((resolve) => streaming.listen(0, '127.0.0.1', resolve));
		let waitTimer: NodeJS.Timeout | undefined;
		try {
			const apiPort = (streaming.address() as AddressInfo).port;
			await store.update('node-1', (current) => ({ ...current, apiPort }));
			const caller = new AbortController();
			const answer = fetch(`${baseUrl}/v1/nodes/node-1/api/head`, {
				headers: { Authorization: `Bearer ${USER}` },
				signal: caller.signal,
			});
			if (isNodeAnswering) {
				// The headers came through the proxy, so the caller leaves mid-body.
				const response = await answer;
				caller.abort();
				await response.text().catch(() => undefined);
			} else {
				await nodeReached;
				caller.abort();
				await answer.catch(() => undefined);
			}
			const outcome = await Promise.race([
				nodeReleased,
				new Promise<'held'>((resolve) => {
					waitTimer = setTimeout(() => resolve('held'), NODE_RELEASE_WAIT_MS);
				}),
			]);
			expect(outcome).toBe('released');
			// The caller left; the node did nothing wrong.
			await new Promise((resolve) => setTimeout(resolve, LATE_LOG_WAIT_MS));
			expect(loggedErrors).toEqual([]);
		} finally {
			clearTimeout(waitTimer);
			streaming.closeAllConnections();
			await new Promise<void>((resolve) => streaming.close(() => resolve()));
		}
	});

	// The response's 'close' fired before the proxy could listen for it, so the
	// proxy opened a connection to the node and left it open. No request went
	// out on it: piping a destroyed request never ends the node's request. A
	// pipelined request's response waits without a socket, and on some Node
	// versions a hang-up never destroys it, only its request.
	it.each([
		[
			'a caller',
			1,
			(): (() => void) => {
				const caller = new AbortController();
				fetch(`${baseUrl}/v1/nodes/node-1/api/head`, {
					headers: { Authorization: `Bearer ${USER}` },
					signal: caller.signal,
				}).catch(() => undefined);
				return () => caller.abort();
			},
		],
		[
			'a caller with two pipelined requests',
			2,
			(): (() => void) => {
				const socket = connect((host.address() as AddressInfo).port, '127.0.0.1');
				socket.on('error', () => undefined);
				const request = `GET /v1/nodes/node-1/api/head HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${USER}\r\n\r\n`;
				socket.write(request.repeat(2));
				return () => socket.destroy();
			},
		],
	])('never contacts the node when %s hangs up while the record is read', async (_label, requestCount, send) => {
		let nodeConnections = 0;
		node.server.on('connection', () => {
			nodeConnections += 1;
		});
		const reads = holdRecordReads(requestCount);
		try {
			const hangUp = send();
			await reads.allHeld;
			hangUp();
			await reads.allDone;
			// Lets the abandoned requests reach the proxy before the next one starts.
			await new Promise((resolve) => setImmediate(resolve));

			// The node accepts connections in the order they were opened, so any
			// an abandoned request opened lands before this answer.
			expect((await call('GET', '/v1/nodes/node-1/api/snapshot', USER)).status).toBe(200);
			expect(nodeConnections).toBe(1);
			expect(node.received.map((request) => request.url)).toEqual(['/snapshot']);
		} finally {
			// A failed run leaves an abandoned connection open, and afterEach's
			// close() would wait on it until jest's own timeout hid the failure.
			node.server.closeAllConnections();
		}
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
		wss.on(
			'connection',
			(
				socket: { send: (d: string) => void; on: (e: string, cb: (d: Buffer) => void) => void },
				request: { url?: string },
			) => {
				greeted.push(request.url ?? '');
				socket.send(JSON.stringify({ tag: 'Greetings' }));
				socket.on('message', (data: Buffer) => socket.send(data.toString()));
			},
		);
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

	// The upgrade gate only refuses new sessions. A session opened before the
	// request would keep forwarding commands until the supervisor drains the node.
	it.each(['stop', 'restart'])('cuts a session that was already open when %s is requested', async (action) => {
		const upstream = await upgradeableNode();
		await store.update('node-1', (current) => ({ ...current, apiPort: upstream.port }));
		const WebSocket = (await import('ws')).default;
		const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/v1/nodes/node-1/api`, {
			headers: { Authorization: `Bearer ${USER}` },
		} as never);
		const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
		await new Promise<void>((resolve) => socket.on('message', () => resolve()));

		expect((await call('POST', `/v1/nodes/node-1/${action}`, ADMIN)).status).toBe(202);

		await closed;
		await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
	});

	it('rejects an upgrade on any path other than the api root', async () => {
		expect((await connect('/v1/nodes/node-1/api/config', USER)).status).toBe(404);
	});
});

// The API kicks the supervisor without waiting, so after a stop or restart the
// record stays `Running` until a tick drains the node. A command admitted in
// that window lands on a node the operator has already taken away.
describe('admission while a stop or restart is pending', () => {
	const connect = async (url: string, token: string): Promise<number | null> => {
		const WebSocket = (await import('ws')).default;
		return new Promise((resolve) => {
			const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}${url}`, {
				headers: { Authorization: `Bearer ${token}` },
			} as never);
			socket.on('open', () => {
				socket.close();
				resolve(null);
			});
			socket.on('unexpected-response', (_req: unknown, res: { statusCode?: number }) =>
				resolve(res.statusCode ?? null),
			);
			socket.on('error', () => resolve(null));
		});
	};

	beforeEach(async () => {
		await store.update('node-1', (current) => ({
			...current,
			lastObservation: {
				checkedAt: new Date().toISOString(),
				responsive: true,
				chainSynced: true,
				drift: 'Healthy',
				driftSeconds: 0,
			},
		}));
	});

	it('does not treat a stale chain observation as fresh or usable', async () => {
		const staleAt = new Date(Date.now() - 5 * 60_000).toISOString();
		await store.update('node-1', (current) => ({
			...current,
			lastObservation: { ...current.lastObservation!, checkedAt: staleAt },
		}));

		const health = await (await call('GET', '/v1/nodes/node-1/health', USER)).json();
		expect(health).toMatchObject({
			usable: false,
			chainSynced: true,
			observationFresh: false,
			lastCheckedAt: staleAt,
		});
	});

	it.each([
		['invalid', () => 'not-a-timestamp'],
		['future', () => new Date(Date.now() + 5 * 60_000).toISOString()],
	])('does not trust an %s chain observation time', async (_label, checkedAt) => {
		await store.update('node-1', (current) => ({
			...current,
			lastObservation: { ...current.lastObservation!, checkedAt: checkedAt() },
		}));

		const health = await (await call('GET', '/v1/nodes/node-1/health', USER)).json();
		expect(health).toMatchObject({ usable: false, chainSynced: true, observationFresh: false });
	});

	it.each([
		['stop', 'stopping'],
		['restart', 'restarting'],
	])('refuses new requests on every gate as soon as %s is requested', async (action, reason) => {
		expect(await (await call('GET', '/v1/nodes/node-1/health', USER)).json()).toMatchObject({
			usable: true,
			observationFresh: true,
		});

		expect((await call('POST', `/v1/nodes/node-1/${action}`, ADMIN)).status).toBe(202);
		expect(tickCalls).toBeGreaterThan(0);
		expect((await store.read('node-1'))?.state).toBe('Running');

		const health = (await (await call('GET', '/v1/nodes/node-1/health', USER)).json()) as { usable: boolean };
		expect(health.usable).toBe(false);

		const proxied = await call('GET', '/v1/nodes/node-1/api/head', USER);
		expect(proxied.status).toBe(409);
		expect((await proxied.json()) as { error: string }).toMatchObject({
			error: expect.stringContaining(reason) as unknown as string,
		});
		expect(await connect('/v1/nodes/node-1/api', USER)).toBe(409);
		expect(node.received).toHaveLength(0);
	});
});
