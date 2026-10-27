import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { connect, type AddressInfo, type Socket } from 'node:net';
import { createServer, request as httpRequest, type Server } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadHostConfig, type EnvSource } from '../config.js';
import { MAX_NODES_PER_NAMESPACE, PortAllocator } from '../registry/ports.js';
import { NodeRegistryStore } from '../registry/store.js';
import type { Supervisor } from '../supervisor/supervisor.js';
import { ExchangeStore } from '../registry/exchange-store.js';
import { createControlPlane, type ServerDeps } from './server.js';
import { acknowledgeEscrow, provisionNode, type ProvisionDeps } from './provision.js';
import { deriveNodeToken } from './node-token.js';
import { createBoundedPeerResolver, PeerResolverUnavailableError } from '../peer-dns.js';
import type { PeerHostnameResolver } from './peer-allowlist.js';

const PEER = {
	advertise: 'hydra2.example.com:5001',
	hydraVerificationKey: `5820${'ab'.repeat(32)}`,
	cardanoVerificationKey: `5820${'cd'.repeat(32)}`,
};

const ADMIN = 'a'.repeat(40);
const USER = 'u'.repeat(40);

const env: EnvSource = {
	get: (key) =>
		({
			HYDRA_HOST_PUBLIC_HOST: 'hydra1.example.com',
			HYDRA_HOST_PUBLIC_EXCHANGE_URL: 'https://exchange.hydra1.example.com:8444/exchange',
			HYDRA_HOST_ADMIN_TOKEN: ADMIN,
			HYDRA_HOST_USER_TOKEN: USER,
			HYDRA_HOST_PEER_PORT_COUNT: '4',
		})[key],
};

let dataDir: string;
let server: Server;
let baseUrl: string;
let counter: number;
let warnings: string[];
let checkPeerTarget: ProvisionDeps['checkPeerTarget'];
let resolvePeerHostname: PeerHostnameResolver;
let exchangeStore: ExchangeStore;
let serverDeps: ServerDeps;

beforeEach(async () => {
	dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hydra-host-api-'));
	counter = 0;
	warnings = [];
	checkPeerTarget = async () => null;
	resolvePeerHostname = async () => [{ address: '8.8.8.8', family: 4 }];
	const config = { ...loadHostConfig(env), dataDir };
	const store = new NodeRegistryStore(dataDir);
	exchangeStore = new ExchangeStore(dataDir);
	const ports = new PortAllocator(config.ports);
	const provision: ProvisionDeps = {
		store,
		ports,
		advertiseFor: (peerPort) => `hydra1.example.com:${peerPort}`,
		checkPeerTarget: async (...args) => await checkPeerTarget(...args),
		newNodeId: () => `node-${++counter}`,
		now: () => new Date('2026-07-28T12:00:00.000Z'),
	};
	// The supervisor is only nudged by the API; its behaviour is tested elsewhere.
	const supervisor = { tick: async () => undefined } as unknown as Supervisor;

	serverDeps = {
		config,
		store,
		exchange: exchangeStore,
		ports,
		supervisor,
		provision,
		resolvePeerHostname: async (...args) => await resolvePeerHostname(...args),
		logger: {
			info: () => undefined,
			warn: (message: string) => {
				warnings.push(message);
			},
			error: () => undefined,
		},
	};
	server = createControlPlane(serverDeps);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

describe('peer firewall refresh', () => {
	it('bounds a stalled hostname lookup and closes the affected peer port', async () => {
		const created = (await (await call('POST', '/v1/nodes', { token: ADMIN, idempotencyKey: 'dns-stall' })).json()) as {
			nodeId: string;
		};
		expect((await call('PATCH', `/v1/nodes/${created.nodeId}`, { token: ADMIN, body: { peers: [PEER] } })).status).toBe(
			200,
		);
		let lookupCalls = 0;
		resolvePeerHostname = createBoundedPeerResolver(
			async () => {
				lookupCalls += 1;
				return await new Promise<readonly { address: string; family: number }[]>(() => undefined);
			},
			{ maxPending: 1, timeoutMs: 20 },
		);

		const response = await call('GET', '/v1/peer-allowlist', { token: ADMIN });
		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			rules: Array<{ nodeId: string; closed: boolean; resolutionErrors: Array<{ reason: string }> }>;
		};
		expect(lookupCalls).toBe(1);
		expect(body.rules.find((rule) => rule.nodeId === created.nodeId)).toMatchObject({
			closed: true,
			resolutionErrors: [{ reason: 'peer lookup timed out' }],
		});
	});
});

function countConnections(target: Server): Promise<number> {
	return new Promise((resolve, reject) =>
		target.getConnections((error, count) => (error ? reject(error) : resolve(count))),
	);
}

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 300; attempt += 1) {
		if (await condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error('condition not met');
}

afterEach(async () => {
	// A failed socket test can leave a connection open, and close waits for it.
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await fs.rm(dataDir, { recursive: true, force: true });
});

const call = (
	method: string,
	url: string,
	options: { token?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<Response> => {
	const headers: Record<string, string> = { 'Content-Type': 'application/json' };
	if (options.token !== undefined) {
		headers.Authorization = `Bearer ${options.token}`;
	}
	if (options.idempotencyKey !== undefined) {
		headers['Idempotency-Key'] = options.idempotencyKey;
	}
	return fetch(`${baseUrl}${url}`, {
		method,
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
};

describe('invite deletion', () => {
	it('refuses a redeemed invite unless the operator explicitly discards it', async () => {
		await exchangeStore.registerInvite({
			nonce: 'raced-revoke',
			hostNodeId: 'missing-node',
			issuedAt: Date.now(),
			expiresAt: Date.now() + 60_000,
			redeemedAt: null,
			redeemer: null,
			redeemerSignature: null,
			startError: null,
		});
		await exchangeStore.redeem(
			'raced-revoke',
			{
				walletAddress: 'addr_test1them',
				hydraVerificationKey: PEER.hydraVerificationKey,
				cardanoVerificationKey: PEER.cardanoVerificationKey,
				advertise: PEER.advertise,
				exchangeUrl: 'https://them.example.com/exchange',
			},
			{ signature: 'sig', key: 'key' },
		);

		expect((await call('DELETE', '/v1/invites/raced-revoke', { token: ADMIN })).status).toBe(409);
		expect((await exchangeStore.listInvites())[0]?.redeemerSignature).toEqual({ signature: 'sig', key: 'key' });
		expect((await call('DELETE', '/v1/invites/raced-revoke?discardRedemption=true', { token: ADMIN })).status).toBe(
			200,
		);
		expect(await exchangeStore.listInvites()).toEqual([]);
	});
});

describe('control plane auth', () => {
	it('returns 503 for a temporary peer resolver failure', async () => {
		checkPeerTarget = async () => {
			throw new PeerResolverUnavailableError('peer resolver is busy');
		};
		const response = await call('POST', '/v1/peers/check', {
			token: ADMIN,
			body: { advertise: 'peer.example.com:5001' },
		});
		expect(response.status).toBe(503);
		expect(response.headers.get('retry-after')).toBe('1');
		expect(await response.json()).toEqual({ error: 'peer resolver is temporarily unavailable' });
	});

	it('rejects an unauthenticated request', async () => {
		expect((await call('GET', '/v1/nodes')).status).toBe(401);
	});

	it('rejects an admin route presented with the user token', async () => {
		expect((await call('GET', '/v1/nodes', { token: USER })).status).toBe(403);
	});

	it('accepts an admin route with the admin token', async () => {
		expect((await call('GET', '/v1/nodes', { token: ADMIN })).status).toBe(200);
	});

	it('reports the configured public Exchange Plane URL to an admin', async () => {
		const response = await call('GET', '/v1/capabilities', { token: ADMIN });

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			exchangeUrl: 'https://exchange.hydra1.example.com:8444/exchange',
		});
	});

	it('logs a refused invite route with a digest, never the open nonce', async () => {
		expect((await call('DELETE', '/v1/invites/nonce123456', { token: USER })).status).toBe(403);

		expect(warnings).toEqual([expect.stringContaining('DELETE /v1/invites/sha256:575140b1803e rejected')]);
		expect(warnings.join('\n')).not.toContain('nonce123456');
	});

	it('404s an unknown path without revealing whether a token would help', async () => {
		expect((await call('GET', '/v1/unknown', { token: ADMIN })).status).toBe(404);
	});

	// The node's own API must not be reachable through the control plane; GET
	// /config there discloses signing-key paths.
	it('does not proxy the node API', async () => {
		expect((await call('GET', '/v1/nodes/node-1/config', { token: ADMIN })).status).toBe(404);
	});
});

describe('control plane connection limits', () => {
	it('refuses a connection past the cap and says so in the log', async () => {
		const { port } = server.address() as AddressInfo;
		const open = (): Promise<Socket> =>
			new Promise((resolve, reject) => {
				const socket = connect(port, '127.0.0.1', () => resolve(socket));
				socket.on('error', reject);
			});
		const held: Socket[] = [];
		try {
			for (let index = 0; index < server.maxConnections; index += 1) held.push(await open());
			await waitFor(async () => (await countConnections(server)) === server.maxConnections);

			const refused = await open();
			held.push(refused);
			let isRefusedClosed = false;
			refused.once('close', () => (isRefusedClosed = true)).resume();
			await waitFor(async () => isRefusedClosed);

			expect(warnings.some((warning) => warning.includes('connection cap'))).toBe(true);
		} finally {
			for (const socket of held) socket.destroy();
		}
	});

	it('leaves connection headroom at the largest supported Head capacity', () => {
		const overrides: Record<string, string> = {
			HYDRA_HOST_PEER_PORT_START: '10000',
			HYDRA_HOST_API_PORT_START: '20000',
			HYDRA_HOST_MONITORING_PORT_START: '30000',
			HYDRA_HOST_PEER_PORT_COUNT: String(MAX_NODES_PER_NAMESPACE),
		};
		const config = {
			...loadHostConfig({ get: (key) => overrides[key] ?? env.get(key) }),
			dataDir,
		};
		const ports = new PortAllocator(config.ports);
		const highCapacityServer = createControlPlane({
			...serverDeps,
			config,
			ports,
			provision: { ...serverDeps.provision, ports },
		});
		expect(highCapacityServer.maxConnections).toBeGreaterThan(config.ports.capacity);
		expect(highCapacityServer.maxConnections).toBeLessThan(config.ports.capacity * 16);
	});
});

describe('the landing page and browser 404', () => {
	it('serves an unauthenticated landing page on the root', async () => {
		const response = await fetch(`${baseUrl}/`);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/html');
		expect(await response.text()).toContain('Masumi Hydra Host');
	});

	it('keeps everything but the root token-gated', async () => {
		// The landing page must not have widened the unauthenticated surface.
		expect((await fetch(`${baseUrl}/v1/nodes`)).status).toBe(401);
	});

	it('serves the OpenAPI document and its Swagger UI unauthenticated', async () => {
		const spec = await fetch(`${baseUrl}/openapi.json`);
		expect(spec.status).toBe(200);
		const body = (await spec.json()) as { openapi: string; paths: Record<string, unknown> };
		expect(body.openapi).toBe('3.0.3');
		expect(Object.keys(body.paths).length).toBeGreaterThan(10);

		const docs = await fetch(`${baseUrl}/docs`);
		expect(docs.status).toBe(200);
		expect(docs.headers.get('content-type')).toContain('text/html');
		expect(await docs.text()).toContain('/docs/assets/swagger-ui-bundle.js');

		const bundle = await fetch(`${baseUrl}/docs/assets/swagger-ui-bundle.js`);
		expect(bundle.status).toBe(200);
		await bundle.arrayBuffer();
		const theme = await fetch(`${baseUrl}/docs/assets/swagger-custom.css`);
		expect(theme.status).toBe(200);
		await theme.text();
		// The allow-list is exact names only: no traversal out of the asset dirs.
		expect((await fetch(`${baseUrl}/docs/assets/..%2Fpackage.json`)).status).toBe(404);
		// Inherited Object.prototype names must not slip past the allow-list
		// (a bare index lookup would return e.g. Function for 'constructor').
		for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
			expect((await fetch(`${baseUrl}/docs/assets/${name}`)).status).toBe(404);
		}
	});

	// Guards against a streamed answer that drops the length.
	it('serves the large public documentation bundle whole, with its length', async () => {
		const bundle = await fetch(`${baseUrl}/docs/assets/swagger-ui-bundle.js`);
		expect(bundle.status).toBe(200);
		const body = await bundle.arrayBuffer();
		expect(body.byteLength).toBeGreaterThan(1_000_000);
		expect(Number(bundle.headers.get('content-length'))).toBe(body.byteLength);

		const head = await fetch(`${baseUrl}/docs/assets/swagger-ui-bundle.js`, { method: 'HEAD' });
		expect(head.status).toBe(200);
		expect(Number(head.headers.get('content-length'))).toBeGreaterThan(1_000_000);
	});

	it('sends hardening headers on the unauthenticated pages', async () => {
		const landing = await fetch(`${baseUrl}/`);
		expect(landing.headers.get('x-content-type-options')).toBe('nosniff');
		expect(landing.headers.get('x-frame-options')).toBe('DENY');
		expect(landing.headers.get('referrer-policy')).toBe('no-referrer');
		expect(landing.headers.get('x-robots-tag')).toBe('noindex, nofollow');
		const spec = await fetch(`${baseUrl}/openapi.json`);
		expect(spec.headers.get('x-content-type-options')).toBe('nosniff');
		expect(spec.headers.get('x-robots-tag')).toBe('noindex, nofollow');
		const docs = await fetch(`${baseUrl}/docs`);
		expect(docs.headers.get('x-robots-tag')).toBe('noindex, nofollow');
	});

	it('does not disclose the network on the unauthenticated surface', async () => {
		// The network lives behind the token-gated capabilities endpoint.
		expect(await (await fetch(`${baseUrl}/`)).text()).not.toMatch(/preprod|mainnet|preview/i);
		expect(await (await fetch(`${baseUrl}/openapi.json`)).text()).not.toMatch(/preprod|mainnet|preview/i);
	});

	it('gives browsers an HTML 404 and API clients the JSON one', async () => {
		const browser = await fetch(`${baseUrl}/nope`, { headers: { Accept: 'text/html,*/*;q=0.8' } });
		expect(browser.status).toBe(404);
		expect(browser.headers.get('content-type')).toContain('text/html');

		const client = await fetch(`${baseUrl}/nope`);
		expect(client.status).toBe(404);
		expect(await client.json()).toEqual({ error: 'not found' });
	});
});

describe('provisioning over HTTP', () => {
	it('returns key material exactly once, then seals it', async () => {
		const created = await call('POST', '/v1/nodes', { token: ADMIN, idempotencyKey: 'idem-1' });
		expect(created.status).toBe(201);
		const body = (await created.json()) as { nodeId: string; secrets: { hydraSigningKey: string } | null };
		expect(body.secrets?.hydraSigningKey).toContain('HydraSigningKey_ed25519');

		// A replay before acknowledgement returns the same material.
		const replay = await call('POST', '/v1/nodes', { token: ADMIN, idempotencyKey: 'idem-1' });
		expect(replay.status).toBe(200);
		expect(((await replay.json()) as { secrets: unknown }).secrets).toEqual(body.secrets);

		expect((await call('POST', `/v1/nodes/${body.nodeId}/escrow-ack`, { token: ADMIN })).status).toBe(200);

		// After acknowledgement the keys are gone for good.
		const afterAck = await call('POST', '/v1/nodes', { token: ADMIN, idempotencyKey: 'idem-1' });
		expect(((await afterAck.json()) as { secrets: unknown }).secrets).toBeNull();
	});

	it('requires an idempotency key', async () => {
		expect((await call('POST', '/v1/nodes', { token: ADMIN })).status).toBe(400);
	});

	it('never exposes loopback ports or signing keys on a listed node', async () => {
		await call('POST', '/v1/nodes', { token: ADMIN, idempotencyKey: 'idem-1' });
		const listed = await (await call('GET', '/v1/nodes', { token: ADMIN })).text();

		expect(listed).not.toContain('apiPort');
		expect(listed).not.toContain('monitoringPort');
		expect(listed).not.toContain('SigningKey');
	});

	it('accepts peers and reports them back', async () => {
		const created = await (await call('POST', '/v1/nodes', { token: ADMIN, idempotencyKey: 'idem-1' })).json();
		const { nodeId } = created as { nodeId: string };

		const patched = await call('PATCH', `/v1/nodes/${nodeId}`, {
			token: ADMIN,
			body: {
				peers: [
					{
						advertise: 'hydra2.example.com:5001',
						hydraVerificationKey: `5820${'ab'.repeat(32)}`,
						cardanoVerificationKey: `5820${'cd'.repeat(32)}`,
					},
				],
			},
		});
		expect(patched.status).toBe(200);
		expect(((await patched.json()) as { peers: unknown[] }).peers).toHaveLength(1);
	});

	it('rejects a malformed peer payload', async () => {
		const created = await (await call('POST', '/v1/nodes', { token: ADMIN, idempotencyKey: 'idem-1' })).json();
		const { nodeId } = created as { nodeId: string };

		expect((await call('PATCH', `/v1/nodes/${nodeId}`, { token: ADMIN, body: { peers: 'nope' } })).status).toBe(400);
		expect((await call('PATCH', `/v1/nodes/${nodeId}`, { token: ADMIN, body: { peers: [{}] } })).status).toBe(400);
	});

	it('lets the user tier read node health', async () => {
		const created = await (await call('POST', '/v1/nodes', { token: ADMIN, idempotencyKey: 'idem-1' })).json();
		const { nodeId } = created as { nodeId: string };

		const health = await call('GET', `/v1/nodes/${nodeId}/health`, { token: USER });
		expect(health.status).toBe(200);
		expect((await health.json()) as { state: string }).toMatchObject({ state: 'PendingEscrow' });
	});

	it('404s health for an unknown node', async () => {
		expect((await call('GET', '/v1/nodes/missing/health', { token: USER })).status).toBe(404);
	});
});

describe('lifecycle guards over HTTP', () => {
	const provisionAndAck = async (key = 'idem-1'): Promise<string> => {
		const created = (await (await call('POST', '/v1/nodes', { token: ADMIN, idempotencyKey: key })).json()) as {
			nodeId: string;
		};
		await call('POST', `/v1/nodes/${created.nodeId}/escrow-ack`, { token: ADMIN });
		return created.nodeId;
	};

	/** Point a running node record at a fake node that answers each API path after its delay, naming the path. */
	const withSlowNode = async (
		idempotencyKey: string,
		delaysMs: Record<string, number>,
		run: (nodeId: string) => Promise<void>,
	): Promise<void> => {
		const slowNode = createServer((request, response) => {
			const { pathname } = new URL(request.url ?? '/', 'http://node');
			setTimeout(() => response.end(JSON.stringify({ answered: pathname })), delaysMs[pathname] ?? 0);
		});
		await new Promise<void>((resolve) => slowNode.listen(0, '127.0.0.1', resolve));
		try {
			const nodeId = await provisionAndAck(idempotencyKey);
			await new NodeRegistryStore(dataDir).update(nodeId, (current) => ({
				...current,
				state: 'Running',
				desired: 'Running',
				apiPort: (slowNode.address() as AddressInfo).port,
			}));
			await run(nodeId);
		} finally {
			slowNode.closeAllConnections();
			await new Promise<void>((resolve) => slowNode.close(() => resolve()));
		}
	};

	/**
	 * Write raw HTTP/1.1 on one socket to the Host. Report what came back once
	 * the socket closes, or once `isDone` holds, which then closes it.
	 */
	const rawExchange = (
		payload: string,
		isDone: (text: string) => boolean = () => false,
	): Promise<{ text: string; closedAfterMs: number }> =>
		new Promise((resolve) => {
			const startedAt = Date.now();
			let text = '';
			const socket = connect((server.address() as AddressInfo).port, '127.0.0.1', () => socket.write(payload));
			socket.on('data', (chunk: Buffer) => {
				text += chunk.toString();
				if (isDone(text)) socket.destroy();
			});
			socket.on('close', () => resolve({ text, closedAfterMs: Date.now() - startedAt }));
		});

	const proxiedGet = (nodeId: string, path: string): string =>
		`GET /v1/nodes/${nodeId}/api${path} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${ADMIN}\r\n\r\n`;

	// A node may take longer to answer than the idle timeout allows a caller
	// who sends nothing. An authenticated proxy request waits for it.
	it('lets a proxied request outlast the idle timeout while the node answers', async () => {
		await withSlowNode('idem-slow-node', { '/head': 400 }, async (nodeId) => {
			server.timeout = 200;

			const answered = await call('GET', `/v1/nodes/${nodeId}/api/head`, { token: ADMIN });

			expect(answered.status).toBe(200);
			expect(await answered.text()).toBe('{"answered":"/head"}');
		});
	});

	it('answers a proxied request pipelined behind another one past the idle timeout', async () => {
		await withSlowNode('idem-pipelined', { '/head': 300, '/snapshot': 900 }, async (nodeId) => {
			server.timeout = 200;

			const bothAnswered = (received: string) =>
				received.includes('{"answered":"/head"}') && received.includes('{"answered":"/snapshot"}');

			const { text } = await rawExchange(proxiedGet(nodeId, '/head') + proxiedGet(nodeId, '/snapshot'), bothAnswered);

			expect(bothAnswered(text)).toBe(true);
		});
	});

	// The proxied answer opts out of the idle timeout. A Host answer queued
	// behind it must not inherit that, or a caller who never reads it holds
	// the socket open for good.
	it('closes a slow reader of an answer pipelined behind a proxied one', async () => {
		await withSlowNode('idem-slow-reader', {}, async (nodeId) => {
			server.timeout = 300;
			const hostSocketClosed = new Promise<number>((resolve) => {
				server.once('connection', (hostSocket: Socket) => {
					const startedAt = Date.now();
					hostSocket.on('close', () => resolve(Date.now() - startedAt));
				});
			});
			const bundle = 'GET /docs/assets/swagger-ui-bundle.js HTTP/1.1\r\nHost: x\r\n\r\n';
			const reader = connect((server.address() as AddressInfo).port, '127.0.0.1', () => {
				reader.pause();
				reader.write(proxiedGet(nodeId, '/head') + bundle.repeat(20));
			});
			reader.on('error', () => undefined);
			try {
				expect(await hostSocketClosed).toBeLessThan(3_000);
			} finally {
				reader.destroy();
			}
		});
	}, 10_000);

	it('closes an idle keep-alive socket on the keep-alive timeout after a proxied answer', async () => {
		await withSlowNode('idem-keep-alive', {}, async (nodeId) => {
			server.keepAliveTimeout = 100;
			server.timeout = 5_000;

			const { text, closedAfterMs } = await rawExchange(proxiedGet(nodeId, '/head'));

			expect(text).toContain('{"answered":"/head"}');
			// Node adds a one-second buffer to the keep-alive timeout.
			expect(closedAfterMs).toBeLessThan(3_000);
		});
	});

	// Removal destroys the persistence dir — the only copy of head state here.
	// A node can only hold that state once it has peers, because --peer becomes
	// --initial-cluster and a peerless node never boots.
	it('refuses to delete a peered live node without force, and allows it with force', async () => {
		const nodeId = await provisionAndAck();
		await call('PATCH', `/v1/nodes/${nodeId}`, {
			token: ADMIN,
			body: {
				peers: [
					{
						advertise: 'hydra2.example.com:5101',
						hydraVerificationKey: `5820${'ab'.repeat(32)}`,
						cardanoVerificationKey: `5820${'cd'.repeat(32)}`,
					},
				],
			},
		});
		expect((await call('DELETE', `/v1/nodes/${nodeId}`, { token: ADMIN })).status).toBe(409);
		expect((await call('DELETE', `/v1/nodes/${nodeId}?force=true`, { token: ADMIN })).status).toBe(202);
	});

	// A head invite escrows its node's keys when it is issued and leaves it
	// peerless until someone redeems, so an unredeemed reservation stays
	// revocable without the operator asserting a head is settled.
	it('deletes an acknowledged but peerless node without force', async () => {
		const nodeId = await provisionAndAck('idem-peerless');
		expect((await call('DELETE', `/v1/nodes/${nodeId}`, { token: ADMIN })).status).toBe(202);
	});

	it('keeps an invite node when orphan cleanup requires it to be unclaimed', async () => {
		const nodeId = await provisionAndAck('idem-claimed');
		const nonce = 'nonce-claimed';
		expect(
			(
				await call('POST', '/v1/invites', {
					token: ADMIN,
					body: { nonce, hostNodeId: nodeId, expiresAt: Date.now() + 60_000 },
				})
			).status,
		).toBe(201);

		expect((await call('DELETE', `/v1/nodes/${nodeId}/remove-unclaimed`, { token: ADMIN })).status).toBe(409);
		expect((await call('DELETE', `/v1/invites/${nonce}`, { token: ADMIN })).status).toBe(200);
		expect((await call('DELETE', `/v1/nodes/${nodeId}/remove-unclaimed`, { token: ADMIN })).status).toBe(202);
	});

	it('deletes a never-acknowledged node without force', async () => {
		const created = (await (
			await call('POST', '/v1/nodes', { token: ADMIN, idempotencyKey: 'idem-unacked' })
		).json()) as { nodeId: string };
		expect((await call('DELETE', `/v1/nodes/${created.nodeId}`, { token: ADMIN })).status).toBe(202);
	});

	// Peers become --initial-cluster, fixed at process start.
	it('refuses a peer change once the node is no longer quiescent', async () => {
		const nodeId = await provisionAndAck();
		await call('PATCH', `/v1/nodes/${nodeId}`, { token: ADMIN, body: { peers: [PEER] } });
		await call('POST', `/v1/nodes/${nodeId}/start`, { token: ADMIN });
		// The record is Stopped until the supervisor acts, so force it live.
		const store = new NodeRegistryStore(dataDir);
		await store.update(nodeId, (current) => ({ ...current, state: 'Running' }));

		const patched = await call('PATCH', `/v1/nodes/${nodeId}`, { token: ADMIN, body: { peers: [PEER] } });
		expect(patched.status).toBe(409);
	});

	// A pause stops an unredeemed invite reservation, and Resume must restore it.
	// The planner keeps it idle until a redemption configures peers.
	it('restores a stopped peerless reservation on start', async () => {
		const nodeId = await provisionAndAck();
		expect((await call('POST', `/v1/nodes/${nodeId}/stop`, { token: ADMIN })).status).toBe(202);
		const started = await call('POST', `/v1/nodes/${nodeId}/start`, { token: ADMIN });

		expect(started.status).toBe(202);
		const record = await new NodeRegistryStore(dataDir).read(nodeId);
		expect(record?.desired).toBe('Running');
		expect(record?.peers).toEqual([]);
	});

	// The bug this replaces: restart set desired='Running', which the planner
	// reads as Idle for an already-running node, so the request did nothing.
	it('records an explicit restart rather than silently doing nothing', async () => {
		const nodeId = await provisionAndAck();
		await call('PATCH', `/v1/nodes/${nodeId}`, { token: ADMIN, body: { peers: [PEER] } });

		expect((await call('POST', `/v1/nodes/${nodeId}/restart`, { token: ADMIN })).status).toBe(202);
		const store = new NodeRegistryStore(dataDir);
		expect((await store.read(nodeId))?.restartRequested).toBe(true);
	});

	it('409s a replayed idempotency key carrying different parameters', async () => {
		await call('POST', '/v1/nodes', { token: ADMIN, idempotencyKey: 'idem-x', body: { depositPeriodSeconds: 300 } });
		const clash = await call('POST', '/v1/nodes', {
			token: ADMIN,
			idempotencyKey: 'idem-x',
			body: { depositPeriodSeconds: 600 },
		});
		expect(clash.status).toBe(409);
	});

	it('400s a present-but-invalid period instead of silently defaulting', async () => {
		const bad = await call('POST', '/v1/nodes', {
			token: ADMIN,
			idempotencyKey: 'idem-bad',
			body: { contestationPeriodSeconds: -5 },
		});
		expect(bad.status).toBe(400);
	});

	// Activation == depositPeriod is the invariant this deployment's deadline
	// arithmetic rests on. A request that names a period but no activation must
	// pick up THAT period, never this Host's own default period.
	it('defaults deposit activation to the period the request asked for', async () => {
		const created = (await (
			await call('POST', '/v1/nodes', { token: ADMIN, idempotencyKey: 'idem-act', body: { depositPeriodSeconds: 900 } })
		).json()) as { nodeId: string };

		const record = await new NodeRegistryStore(dataDir).read(created.nodeId);
		expect(record?.depositActivationSeconds).toBe(900);
	});
});

// A separate control plane, because the refusal is computed at boot.
describe('control plane on ledger params above the L2 maxTxSize cap', () => {
	let refusingDir: string;
	let refusingServer: Server;
	let refusingBaseUrl: string;
	let refusingStore: NodeRegistryStore;
	let refusingProvision: ProvisionDeps;

	beforeEach(async () => {
		refusingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hydra-host-params-'));
		const config = { ...loadHostConfig(env), dataDir: refusingDir };
		const store = new NodeRegistryStore(refusingDir);
		const ports = new PortAllocator(config.ports);
		refusingStore = store;
		refusingProvision = {
			store,
			ports,
			advertiseFor: (peerPort) => `hydra1.example.com:${peerPort}`,
			checkPeerTarget: async () => null,
			newNodeId: () => 'node-refused',
			now: () => new Date('2026-07-28T12:00:00.000Z'),
			ledgerParamsRefusal: 'maxTxSize 16384, above 15000',
		};
		refusingServer = createControlPlane({
			config,
			store,
			exchange: new ExchangeStore(refusingDir),
			ports,
			supervisor: { tick: async () => undefined } as unknown as Supervisor,
			provision: refusingProvision,
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
		});
		await new Promise<void>((resolve) => refusingServer.listen(0, '127.0.0.1', resolve));
		refusingBaseUrl = `http://127.0.0.1:${(refusingServer.address() as AddressInfo).port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => refusingServer.close(() => resolve()));
		await fs.rm(refusingDir, { recursive: true, force: true });
	});

	// The Host still boots, so nodes of heads already open keep running; only
	// a node that has no head yet, and would start one on these params, is refused.
	it('refuses to provision a node and keeps serving the rest', async () => {
		const headers = { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' };
		const provisioned = await fetch(`${refusingBaseUrl}/v1/nodes`, {
			method: 'POST',
			headers: { ...headers, 'idempotency-key': 'idem-refused' },
			body: JSON.stringify({}),
		});

		expect(provisioned.status).toBe(409);
		expect(await provisioned.json()).toEqual({ error: 'maxTxSize 16384, above 15000' });
		const listed = await fetch(`${refusingBaseUrl}/v1/nodes`, { headers });
		expect(listed.status).toBe(200);
		expect(await listed.json()).toMatchObject({ nodes: [] });
	});

	/** A node provisioned, and acked if asked, before the Host restarted onto these params. */
	async function nodeFromBeforeRestart(acked: boolean): Promise<string> {
		const beforeRestart = { ...refusingProvision, ledgerParamsRefusal: null };
		const { record } = await provisionNode(
			{
				idempotencyKey: 'idem-before-restart',
				network: 'preprod',
				contestationPeriodSeconds: 60,
				depositPeriodSeconds: 120,
				unsyncedPeriodSeconds: 60,
				depositActivationSeconds: 120,
			},
			beforeRestart,
		);
		if (acked) await acknowledgeEscrow(record.nodeId, beforeRestart);
		return record.nodeId;
	}

	function ack(nodeId: string): Promise<Response> {
		return fetch(`${refusingBaseUrl}/v1/nodes/${nodeId}/escrow-ack`, {
			method: 'POST',
			headers: { authorization: `Bearer ${ADMIN}` },
		});
	}

	// The ack would start it, and it would Init a head on these params.
	it('refuses to ack a node never acked', async () => {
		const nodeId = await nodeFromBeforeRestart(false);

		expect((await ack(nodeId)).status).toBe(409);
		expect((await refusingStore.read(nodeId))?.escrowAckedAt).toBeNull();
	});

	// A repeated ack for an acked node is a no-op, and that node can belong to a
	// head that is already open.
	it('answers a repeated ack for an acked node', async () => {
		const nodeId = await nodeFromBeforeRestart(true);
		const ackedAt = (await refusingStore.read(nodeId))?.escrowAckedAt;

		expect((await ack(nodeId)).status).toBe(200);
		expect((await refusingStore.read(nodeId))?.escrowAckedAt).toBe(ackedAt);
	});

	// An acked node without peers has no head yet: peers would make it start.
	// Redemption recovery sets peers through the same path.
	it('refuses peers for an acked node that has none', async () => {
		const nodeId = await nodeFromBeforeRestart(true);

		const patched = await fetch(`${refusingBaseUrl}/v1/nodes/${nodeId}`, {
			method: 'PATCH',
			headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
			body: JSON.stringify({ peers: [PEER] }),
		});

		expect(patched.status).toBe(409);
		expect((await refusingStore.read(nodeId))?.peers).toEqual([]);
	});
});

// A separate control plane, because the override is read at config load.
describe('control plane with HYDRA_HOST_DEPOSIT_ACTIVATION_SECONDS set', () => {
	let overrideDir: string;
	let overrideServer: Server;
	let overrideBaseUrl: string;

	beforeEach(async () => {
		overrideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hydra-host-act-'));
		const overrideEnv: EnvSource = {
			get: (key) => (key === 'HYDRA_HOST_DEPOSIT_ACTIVATION_SECONDS' ? '777' : env.get(key)),
		};
		const config = { ...loadHostConfig(overrideEnv), dataDir: overrideDir };
		const store = new NodeRegistryStore(overrideDir);
		const ports = new PortAllocator(config.ports);
		overrideServer = createControlPlane({
			config,
			store,
			exchange: new ExchangeStore(overrideDir),
			ports,
			supervisor: { tick: async () => undefined } as unknown as Supervisor,
			provision: {
				store,
				ports,
				advertiseFor: (peerPort) => `hydra1.example.com:${peerPort}`,
				checkPeerTarget: async () => null,
				newNodeId: () => 'node-override',
				now: () => new Date('2026-07-28T12:00:00.000Z'),
			},
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
		});
		await new Promise<void>((resolve) => overrideServer.listen(0, '127.0.0.1', resolve));
		overrideBaseUrl = `http://127.0.0.1:${(overrideServer.address() as AddressInfo).port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => overrideServer.close(() => resolve()));
		await fs.rm(overrideDir, { recursive: true, force: true });
	});

	// The operator's escape hatch has to beat the request: every current
	// payment-service build always sends depositActivationSeconds, so an
	// override that only filled an absent field would never apply to anything.
	it('wins over the value the provision request sent', async () => {
		const response = await fetch(`${overrideBaseUrl}/v1/nodes`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${ADMIN}`,
				'content-type': 'application/json',
				'idempotency-key': 'idem-override',
			},
			body: JSON.stringify({ depositPeriodSeconds: 900, depositActivationSeconds: 900 }),
		});
		const created = (await response.json()) as { nodeId: string };

		const record = await new NodeRegistryStore(overrideDir).read(created.nodeId);
		expect(record?.depositActivationSeconds).toBe(777);
		expect(record?.depositPeriodSeconds).toBe(900);
	});

	// Winning over the request must not mean skipping it. Reading the override
	// first would discard the body unread, so a caller sending a malformed
	// activation would be answered 201 and never learn its request was wrong.
	it('still rejects a malformed activation in the body', async () => {
		const response = await fetch(`${overrideBaseUrl}/v1/nodes`, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${ADMIN}`,
				'content-type': 'application/json',
				'idempotency-key': 'idem-override-invalid',
			},
			body: JSON.stringify({ depositPeriodSeconds: 900, depositActivationSeconds: -5 }),
		});

		expect(response.status).toBe(400);
		// Named, so this keeps failing for the right reason if another 400 is
		// ever added ahead of this one.
		expect(((await response.json()) as { error: string }).error).toContain('depositActivationSeconds');
	});
});

describe('control plane with HYDRA_HOST_REQUIRE_PEER_FIREWALL_REFRESH set', () => {
	let gatedDir: string;
	let gatedServer: Server;
	let gatedStore: NodeRegistryStore;
	let gatedPorts: PortAllocator;
	let gatedUrl: string;
	let nodes: number;

	beforeEach(async () => {
		gatedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hydra-host-gated-'));
		nodes = 0;
		const gatedEnv: EnvSource = {
			get: (key) => (key === 'HYDRA_HOST_REQUIRE_PEER_FIREWALL_REFRESH' ? 'true' : env.get(key)),
		};
		const config = { ...loadHostConfig(gatedEnv), dataDir: gatedDir };
		gatedStore = new NodeRegistryStore(gatedDir);
		gatedPorts = new PortAllocator(config.ports, [], { requirePeerFirewallRefresh: config.requirePeerFirewallRefresh });
		gatedServer = createControlPlane({
			config,
			store: gatedStore,
			exchange: new ExchangeStore(gatedDir),
			ports: gatedPorts,
			supervisor: { tick: async () => undefined } as unknown as Supervisor,
			provision: {
				store: gatedStore,
				ports: gatedPorts,
				advertiseFor: (peerPort) => `hydra1.example.com:${peerPort}`,
				checkPeerTarget: async () => null,
				newNodeId: () => `gated-${++nodes}`,
				now: () => new Date('2026-07-28T12:00:00.000Z'),
			},
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
		});
		await new Promise<void>((resolve) => gatedServer.listen(0, '127.0.0.1', resolve));
		gatedUrl = `http://127.0.0.1:${(gatedServer.address() as AddressInfo).port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => gatedServer.close(() => resolve()));
		await fs.rm(gatedDir, { recursive: true, force: true });
	});

	const gated = (method: string, url: string, body?: unknown, idempotencyKey?: string): Promise<Response> =>
		fetch(`${gatedUrl}${url}`, {
			method,
			headers: {
				authorization: `Bearer ${ADMIN}`,
				'content-type': 'application/json',
				...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	const provision = async (key: string): Promise<Response> => await gated('POST', '/v1/nodes', undefined, key);
	const generation = async (): Promise<string> =>
		((await (await gated('GET', '/v1/peer-allowlist')).json()) as { generation: string }).generation;
	const applied = async (value: unknown): Promise<Response> =>
		await gated('POST', '/v1/peer-allowlist/applied', { generation: value });

	// The firewall script's whole cycle, with the supervisor's removal done by
	// hand: it deletes the record, then releases the port.
	it('reuses a removed node peer port only after a later ruleset is acknowledged', async () => {
		const waiting = await provision('idem-boot');
		expect(waiting.status).toBe(503);
		expect(((await waiting.json()) as { error: string }).error).toContain('hydra-peer-firewall refresh');

		expect(await (await applied(await generation())).json()).toEqual({ released: [] });
		const first = (await (await provision('idem-1')).json()) as { nodeId: string; peerPort: number };
		expect(first.peerPort).toBe(5001);

		const beforeRemoval = await generation();
		await gatedStore.remove(first.nodeId);
		gatedPorts.release(first.peerPort);
		expect(((await (await provision('idem-2')).json()) as { peerPort: number }).peerPort).toBe(5002);

		expect(await (await applied(beforeRemoval)).json()).toEqual({ released: [] });
		expect(await (await applied(await generation())).json()).toEqual({ released: [5001] });
		expect(((await (await provision('idem-3')).json()) as { peerPort: number }).peerPort).toBe(5001);
	});

	it('refuses an acknowledgement the running Host did not issue', async () => {
		expect((await applied('0b6f3c1e-2d4a-4f5b-9c8d-7e6f5a4b3c2d.0')).status).toBe(409);
		expect((await applied(7)).status).toBe(400);
		expect((await provision('idem-refused')).status).toBe(503);
	});
});

describe('node-scoped credentials', () => {
	let strictServer: Server;
	let strictUrl: string;

	beforeEach(async () => {
		const config = { ...loadHostConfig(env), dataDir, acceptHostWideUserToken: false };
		const ports = new PortAllocator(config.ports);
		strictServer = createControlPlane({
			config,
			store: new NodeRegistryStore(dataDir),
			exchange: new ExchangeStore(dataDir),
			ports,
			supervisor: { tick: async () => undefined } as unknown as Supervisor,
			provision: {
				store: new NodeRegistryStore(dataDir),
				ports,
				advertiseFor: (peerPort) => `hydra1.example.com:${peerPort}`,
				checkPeerTarget: async () => null,
				newNodeId: () => 'unused',
				now: () => new Date('2026-07-28T12:00:00.000Z'),
			},
			logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
		});
		await new Promise<void>((resolve) => strictServer.listen(0, '127.0.0.1', resolve));
		strictUrl = `http://127.0.0.1:${(strictServer.address() as AddressInfo).port}`;
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => strictServer.close(() => resolve()));
	});

	async function provisionNodes(): Promise<{ first: string; second: string }> {
		const first = (await (await call('POST', '/v1/nodes', { token: ADMIN, idempotencyKey: 'idem-1' })).json()) as {
			nodeId: string;
		};
		const second = (await (await call('POST', '/v1/nodes', { token: ADMIN, idempotencyKey: 'idem-2' })).json()) as {
			nodeId: string;
		};
		return { first: first.nodeId, second: second.nodeId };
	}

	/** The status of a WebSocket upgrade, which a refusal answers as a plain response. */
	function upgradeStatus(base: string, nodeId: string, token: string): Promise<number> {
		return new Promise((resolve, reject) => {
			const request = httpRequest(`${base}/v1/nodes/${nodeId}/api/`, {
				headers: {
					Authorization: `Bearer ${token}`,
					Connection: 'Upgrade',
					Upgrade: 'websocket',
					'Sec-WebSocket-Version': '13',
					'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
				},
			});
			request.on('response', (response) => {
				response.resume();
				resolve(response.statusCode ?? 0);
			});
			request.on('upgrade', (_response, socket) => {
				socket.destroy();
				resolve(101);
			});
			request.on('error', reject);
			request.end();
		});
	}

	// What each surface answers once the credential is accepted. A node still
	// waiting on its escrow acknowledgement takes no commands, so the proxy
	// answers 409 after authenticating; a refused credential never gets that far.
	const surfaces: Array<{
		name: string;
		accepted: number;
		status: (base: string, nodeId: string, token: string) => Promise<number>;
	}> = [
		{
			name: 'node health',
			accepted: 200,
			status: async (base, nodeId, token) =>
				(await fetch(`${base}/v1/nodes/${nodeId}/health`, { headers: { Authorization: `Bearer ${token}` } })).status,
		},
		{
			name: 'the node API over HTTP',
			accepted: 409,
			status: async (base, nodeId, token) =>
				(await fetch(`${base}/v1/nodes/${nodeId}/api/head`, { headers: { Authorization: `Bearer ${token}` } })).status,
		},
		{ name: 'the node API over WebSocket', accepted: 409, status: upgradeStatus },
	];

	describe.each(surfaces)('$name', ({ accepted, status }) => {
		it('accepts the token derived from the user token for that node', async () => {
			const { first } = await provisionNodes();

			expect(await status(baseUrl, first, deriveNodeToken(USER, first))).toBe(accepted);
			expect(await status(strictUrl, first, deriveNodeToken(USER, first))).toBe(accepted);
		});

		it('accepts the token derived from the admin token for that node', async () => {
			const { first } = await provisionNodes();

			expect(await status(strictUrl, first, deriveNodeToken(ADMIN, first))).toBe(accepted);
		});

		it('refuses the token derived for another node', async () => {
			const { first, second } = await provisionNodes();

			expect(await status(baseUrl, first, deriveNodeToken(USER, second))).toBe(401);
			expect(await status(strictUrl, first, deriveNodeToken(ADMIN, second))).toBe(401);
		});

		it('keeps accepting the Host-wide user token while that is allowed', async () => {
			const { first } = await provisionNodes();

			expect(await status(baseUrl, first, USER)).toBe(accepted);
		});

		it('refuses the Host-wide user token once that is switched off', async () => {
			const { first } = await provisionNodes();

			expect(await status(strictUrl, first, USER)).toBe(401);
		});
	});

	// So an operator can tell when no service is left on the credential that
	// reaches every node, and turn it off.
	it('says once that the Host-wide user token is still being used, and not for node tokens', async () => {
		const { first } = await provisionNodes();
		const health = (token: string) => call('GET', `/v1/nodes/${first}/health`, { token });

		await health(deriveNodeToken(USER, first));
		expect(warnings.filter((message) => message.includes('Host-wide user token'))).toHaveLength(0);

		await health(USER);
		await health(USER);
		expect(warnings.filter((message) => message.includes('Host-wide user token'))).toHaveLength(1);
	});

	it('advertises that it accepts node tokens', async () => {
		const capabilities = await call('GET', '/v1/capabilities', { token: ADMIN });

		expect(((await capabilities.json()) as { nodeScopedTokens: boolean }).nodeScopedTokens).toBe(true);
	});

	it('does not let a node token reach an admin route', async () => {
		const { first } = await provisionNodes();

		expect((await call('GET', `/v1/nodes/${first}`, { token: deriveNodeToken(USER, first) })).status).toBe(401);
		expect((await call('POST', `/v1/nodes/${first}/stop`, { token: deriveNodeToken(ADMIN, first) })).status).toBe(401);
	});
});
