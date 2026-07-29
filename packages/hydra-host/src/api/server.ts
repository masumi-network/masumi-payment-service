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
import { isHostApiError, HostApiError } from './http-error.js';
import { ProvisionError, acknowledgeEscrow, provisionNode, setPeers, type ProvisionDeps } from './provision.js';
import { requestRemoval, requestRestart, requestStart, requestStop } from './transitions.js';
import { isProxyableHttpPath, isProxyableWebSocketPath, matchNodeApiProxy } from './proxy-path.js';
import { proxyHttp, proxyWebSocket } from './proxy.js';
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

	const server = createServer((request, response) => {
		void (async () => {
			const method = request.method ?? 'GET';
			const pathname = new URL(request.url ?? '/', 'http://placeholder').pathname;

			const route = matchRoute(method, pathname);
			if (route === null) {
				await handleNodeApiProxy(method, pathname, request, response);
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
				if (isHostApiError(error)) {
					send(response, error.status, { error: error.message });
					return;
				}
				logger.error(`[api] ${method} ${pathname} failed: ${(error as Error).message}`);
				send(response, 500, { error: 'internal error' });
			}
		})();
	});

	// Bound how long a connection may occupy the control plane. It normally sits
	// behind a load balancer, but the peer plane is public and there is no reason
	// to assume this port never will be. Proxied WebSockets opt out of this
	// per-socket, since a quiet head is legitimately silent for long stretches.
	server.headersTimeout = 15_000;
	server.requestTimeout = 30_000;
	server.keepAliveTimeout = 10_000;

	// WebSocket upgrades never reach the request handler, so they are
	// authenticated and authorised here on their own path.
	server.on('upgrade', (request, socket, head) => {
		void (async () => {
			const rejectUpgrade = (status: number, reason: string): void => {
				logger.warn(`[api] websocket upgrade rejected: ${reason}`);
				socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
				socket.destroy();
			};

			const pathname = new URL(request.url ?? '/', 'http://placeholder').pathname;
			const target = matchNodeApiProxy(pathname);
			if (target === null || !isProxyableWebSocketPath(target.subPath)) {
				rejectUpgrade(404, 'Not Found');
				return;
			}

			const auth = authenticate(request.headers.authorization, tokens, 'user');
			if (!auth.ok) {
				rejectUpgrade(auth.status, auth.status === 403 ? 'Forbidden' : 'Unauthorized');
				return;
			}

			const record = await store.read(target.nodeId).catch(() => null);
			if (record === null) {
				rejectUpgrade(404, 'Not Found');
				return;
			}
			if (record.state !== 'Running') {
				rejectUpgrade(409, 'Conflict');
				return;
			}

			proxyWebSocket(request, socket, head, record.apiPort, target.subPath, (message) =>
				logger.error(`[api] ${message}`),
			);
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

			// Lifecycle endpoints express intent; the guarded transitions validate
			// the precondition and the supervisor performs the work, including the
			// drain. No handler writes `state` or `desired` directly.
			case 'startNode': {
				const record = await requestStart(store, nodeId ?? '');
				void supervisor.tick();
				send(response, 202, toPublicNode(record));
				return;
			}

			case 'stopNode': {
				const record = await requestStop(store, nodeId ?? '');
				void supervisor.tick();
				send(response, 202, toPublicNode(record));
				return;
			}

			case 'restartNode': {
				const record = await requestRestart(store, nodeId ?? '');
				void supervisor.tick();
				send(response, 202, toPublicNode(record));
				return;
			}

			case 'removeNode': {
				const force = new URL(request.url ?? '/', 'http://placeholder').searchParams.get('force') === 'true';
				const record = await requestRemoval(store, nodeId ?? '', { force });
				void supervisor.tick();
				send(response, 202, toPublicNode(record));
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

	/**
	 * Forward an HTTP request to the node's own API.
	 *
	 * Reached only when the control-plane table did not match, and gated by its
	 * own allow-list rather than by whatever the node happens to expose.
	 */
	async function handleNodeApiProxy(
		method: string,
		pathname: string,
		request: IncomingMessage,
		response: ServerResponse,
	): Promise<void> {
		const target = matchNodeApiProxy(pathname);
		if (target === null || !isProxyableHttpPath(method, target.subPath)) {
			send(response, 404, { error: 'not found' });
			return;
		}

		const auth = authenticate(request.headers.authorization, tokens, 'user');
		if (!auth.ok) {
			send(response, auth.status, { error: auth.message });
			return;
		}

		const record = await store.read(target.nodeId);
		if (record === null) {
			send(response, 404, { error: 'no such node' });
			return;
		}
		if (record.state !== 'Running') {
			// Proxying to a node that is not up would surface as a connection
			// refused; saying so plainly is more useful than a 502.
			send(response, 409, { error: `node is ${record.state}, not Running` });
			return;
		}

		proxyHttp(request, response, record.apiPort, target.subPath, (message) => logger.error(`[api] ${message}`));
	}

	return server;
}

/**
 * Read an optional positive-integer field.
 *
 * A present-but-invalid value is rejected rather than silently replaced by the
 * default: quietly provisioning a node with a contestation period the caller
 * never asked for is worse than refusing the request.
 */
function numberOr(body: unknown, key: string, fallback: number): number {
	if (!isPlainObject(body)) {
		return fallback;
	}
	const value = getOwnValue(body, key);
	if (value === undefined || value === null) {
		return fallback;
	}
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
		throw new HostApiError(`${key} must be a positive whole number of seconds`, 400);
	}
	return value;
}
