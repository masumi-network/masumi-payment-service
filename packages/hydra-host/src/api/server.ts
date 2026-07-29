/**
 * Control-plane HTTP server.
 *
 * Plain HTTP by design: TLS terminates at a load balancer or ingress, so the
 * container has no certificate state to keep durable. It honours
 * `X-Forwarded-Proto` for logging only — the token, not the transport, is what
 * authorises a request here.
 *
 * Every route is authenticated before its handler runs, using the tier
 * declared in the route table.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { HostConfig } from '../config.js';
import { readCapabilities } from '../capabilities.js';
import type { PortAllocator } from '../registry/ports.js';
import type { NodeRegistryStore } from '../registry/store.js';
import type { PeerRecord } from '../registry/types.js';
import { getOwnString, getOwnValue, isPlainObject } from '../registry/json.js';
import type { Supervisor, SupervisorLogger } from '../supervisor/supervisor.js';
import { authenticate } from './auth.js';
import { ProvisionError, acknowledgeEscrow, provisionNode, setPeers, type ProvisionDeps } from './provision.js';
import { matchRoute } from './routes.js';
import { toPublicNode } from './serialize.js';

const MAX_BODY_BYTES = 256 * 1024;

export type ServerDeps = {
	config: HostConfig;
	store: NodeRegistryStore;
	ports: PortAllocator;
	supervisor: Supervisor;
	provision: ProvisionDeps;
	logger: SupervisorLogger;
};

function send(response: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body ?? null);
	response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
	response.end(payload);
}

async function readBody(request: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = chunk as Buffer;
		size += buffer.length;
		if (size > MAX_BODY_BYTES) {
			throw new ProvisionError('request body is too large', 400);
		}
		chunks.push(buffer);
	}
	if (size === 0) {
		return null;
	}
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch {
		throw new ProvisionError('request body is not valid JSON', 400);
	}
}

function readPeers(body: unknown): PeerRecord[] {
	if (!isPlainObject(body)) {
		throw new ProvisionError('expected an object with a "peers" array', 400);
	}
	const peers = getOwnValue(body, 'peers');
	if (!Array.isArray(peers)) {
		throw new ProvisionError('"peers" must be an array', 400);
	}
	return peers.map((entry, index) => {
		if (!isPlainObject(entry)) {
			throw new ProvisionError(`peers[${index}] must be an object`, 400);
		}
		const advertise = getOwnString(entry, 'advertise');
		const hydraVerificationKey = getOwnString(entry, 'hydraVerificationKey');
		const cardanoVerificationKey = getOwnString(entry, 'cardanoVerificationKey');
		if (advertise === undefined || hydraVerificationKey === undefined || cardanoVerificationKey === undefined) {
			throw new ProvisionError(`peers[${index}] needs advertise, hydraVerificationKey and cardanoVerificationKey`, 400);
		}
		return { advertise, hydraVerificationKey, cardanoVerificationKey };
	});
}

export function createControlPlane(deps: ServerDeps): Server {
	const { config, store, ports, supervisor, provision, logger } = deps;
	const tokens = { adminToken: config.adminToken, userToken: config.userToken };

	return createServer((request, response) => {
		void (async () => {
			const method = request.method ?? 'GET';
			const pathname = new URL(request.url ?? '/', 'http://placeholder').pathname;

			const route = matchRoute(method, pathname);
			if (route === null) {
				send(response, 404, { error: 'not found' });
				return;
			}

			const auth = authenticate(request.headers.authorization, tokens, route.tier);
			if (!auth.ok) {
				// Never echo the presented credential, and never say which token
				// would have worked.
				logger.warn(`[api] ${method} ${pathname} rejected: ${auth.message}`);
				send(response, auth.status, { error: auth.message });
				return;
			}

			try {
				await handle(route.kind, route.nodeId, request, response);
			} catch (error) {
				if (error instanceof ProvisionError) {
					send(response, error.status, { error: error.message });
					return;
				}
				logger.error(`[api] ${method} ${pathname} failed: ${(error as Error).message}`);
				send(response, 500, { error: 'internal error' });
			}
		})();
	});

	async function handle(
		kind: string,
		nodeId: string | undefined,
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> {
		switch (kind) {
			case 'capabilities': {
				const capabilities = await readCapabilities({
					hydraNodeBin: config.hydraNodeBin,
					ledgerProtocolParametersFile: config.ledgerProtocolParametersFile,
					network: config.network,
					slots: () => ({ used: ports.used, capacity: config.ports.capacity }),
				});
				send(response, 200, capabilities);
				return;
			}

			case 'listNodes': {
				const records = await store.list();
				send(response, 200, { nodes: records.map(toPublicNode) });
				return;
			}

			case 'getNode': {
				const record = await store.read(nodeId ?? '');
				if (record === null) {
					send(response, 404, { error: 'no such node' });
					return;
				}
				send(response, 200, toPublicNode(record));
				return;
			}

			case 'provisionNode': {
				const body = await readBody(request);
				const idempotencyKey =
					(typeof request.headers['idempotency-key'] === 'string' ? request.headers['idempotency-key'] : '') || '';
				const result = await provisionNode(
					{
						idempotencyKey,
						network: config.network,
						contestationPeriodSeconds: numberOr(
							body,
							'contestationPeriodSeconds',
							config.defaultContestationPeriodSeconds,
						),
						depositPeriodSeconds: numberOr(body, 'depositPeriodSeconds', config.defaultDepositPeriodSeconds),
						unsyncedPeriodSeconds: numberOr(body, 'unsyncedPeriodSeconds', config.defaultUnsyncedPeriodSeconds),
					},
					provision,
				);
				// The only response that ever carries key material.
				send(response, result.replayed ? 200 : 201, {
					...toPublicNode(result.record),
					secrets: result.secrets,
				});
				return;
			}

			case 'escrowAck': {
				const record = await acknowledgeEscrow(nodeId ?? '', provision);
				void supervisor.tick();
				send(response, 200, toPublicNode(record));
				return;
			}

			case 'setPeers': {
				const peers = readPeers(await readBody(request));
				const record = await setPeers(nodeId ?? '', peers, provision);
				void supervisor.tick();
				send(response, 200, toPublicNode(record));
				return;
			}

			case 'startNode':
			case 'stopNode':
			case 'restartNode': {
				const desired = kind === 'stopNode' ? 'Stopped' : 'Running';
				const updated = await store.update(nodeId ?? '', (current) => ({ ...current, desired }));
				if (updated === null) {
					send(response, 404, { error: 'no such node' });
					return;
				}
				// The supervisor performs the transition, including the drain.
				void supervisor.tick();
				send(response, 202, toPublicNode(updated));
				return;
			}

			case 'removeNode': {
				const updated = await store.update(nodeId ?? '', (current) => ({ ...current, state: 'Removing' }));
				if (updated === null) {
					send(response, 404, { error: 'no such node' });
					return;
				}
				void supervisor.tick();
				send(response, 202, toPublicNode(updated));
				return;
			}

			case 'nodeHealth': {
				const record = await store.read(nodeId ?? '');
				if (record === null) {
					send(response, 404, { error: 'no such node' });
					return;
				}
				send(response, 200, {
					nodeId: record.nodeId,
					state: record.state,
					desired: record.desired,
					restartCount: record.restartCount,
					lastStopUndrained: record.lastStopUndrained,
					failureReason: record.failureReason ?? null,
				});
				return;
			}

			default:
				send(response, 404, { error: 'not found' });
		}
	}
}

function numberOr(body: unknown, key: string, fallback: number): number {
	if (!isPlainObject(body)) {
		return fallback;
	}
	const value = getOwnValue(body, key);
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
