import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadHostConfig, type EnvSource } from '../config.js';
import { PortAllocator } from '../registry/ports.js';
import { NodeRegistryStore } from '../registry/store.js';
import type { Supervisor } from '../supervisor/supervisor.js';
import { ExchangeStore } from '../registry/exchange-store.js';
import { createControlPlane } from './server.js';
import type { ProvisionDeps } from './provision.js';

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
			HYDRA_HOST_ADMIN_TOKEN: ADMIN,
			HYDRA_HOST_USER_TOKEN: USER,
			HYDRA_HOST_PEER_PORT_COUNT: '4',
		})[key],
};

let dataDir: string;
let server: Server;
let baseUrl: string;
let counter: number;

beforeEach(async () => {
	dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hydra-host-api-'));
	counter = 0;
	const config = { ...loadHostConfig(env), dataDir };
	const store = new NodeRegistryStore(dataDir);
	const ports = new PortAllocator(config.ports);
	const provision: ProvisionDeps = {
		store,
		ports,
		advertiseFor: (peerPort) => `hydra1.example.com:${peerPort}`,
		newNodeId: () => `node-${++counter}`,
		now: () => new Date('2026-07-28T12:00:00.000Z'),
	};
	// The supervisor is only nudged by the API; its behaviour is tested elsewhere.
	const supervisor = { tick: async () => undefined } as unknown as Supervisor;

	server = createControlPlane({
		config,
		store,
		exchange: new ExchangeStore(dataDir),
		ports,
		supervisor,
		provision,
		logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
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

describe('control plane auth', () => {
	it('rejects an unauthenticated request', async () => {
		expect((await call('GET', '/v1/nodes')).status).toBe(401);
	});

	it('rejects an admin route presented with the user token', async () => {
		expect((await call('GET', '/v1/nodes', { token: USER })).status).toBe(403);
	});

	it('accepts an admin route with the admin token', async () => {
		expect((await call('GET', '/v1/nodes', { token: ADMIN })).status).toBe(200);
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

	// Removal destroys the persistence dir — the only copy of head state here.
	it('refuses to delete a live node without force, and allows it with force', async () => {
		const nodeId = await provisionAndAck();
		expect((await call('DELETE', `/v1/nodes/${nodeId}`, { token: ADMIN })).status).toBe(409);
		expect((await call('DELETE', `/v1/nodes/${nodeId}?force=true`, { token: ADMIN })).status).toBe(202);
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

	it('refuses to start a node before peers are configured', async () => {
		const nodeId = await provisionAndAck();
		const started = await call('POST', `/v1/nodes/${nodeId}/start`, { token: ADMIN });
		expect(started.status).toBe(409);
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
});
