/**
 * Reverse proxy onto a supervised node's own API.
 *
 * The node binds loopback and has no authentication, so this is the only path
 * to it — the token check happens before anything here runs, and the allow-list
 * in `proxy-path.ts` decides what may be forwarded at all.
 *
 * Two behaviours are load-bearing and easy to lose to a "sensible default":
 *
 *  - **Nothing is buffered.** The payment service replays the full event log
 *    over a WebSocket (`?history=yes`), which can be large and slow; buffering
 *    it would blow memory and stall the replay.
 *  - **Idle timeouts are disabled on proxied connections.** A quiet head sends
 *    nothing for long stretches, and the control plane's own short timeouts
 *    (which exist to bound ordinary requests) would tear those sockets down.
 */

import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';

/**
 * The upgrade socket is a `net.Socket` at runtime, but `server.on('upgrade')`
 * types it as a bare `Duplex`. Declaring the two methods we need as optional is
 * honest about that gap without casting away the type.
 */
type UpgradeSocket = Duplex & Partial<Pick<Socket, 'setTimeout' | 'setNoDelay'>>;

const LOOPBACK = '127.0.0.1';

/** Headers that must never be forwarded upstream. */
const STRIPPED_REQUEST_HEADERS = new Set([
	// Our credential, not the node's business — and the node would ignore it
	// while it sat in its logs.
	'authorization',
	'idempotency-key',
	'host',
	// Hop-by-hop.
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
]);

function forwardableHeaders(source: IncomingMessage['headers']): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(source)) {
		if (STRIPPED_REQUEST_HEADERS.has(key.toLowerCase()) || value === undefined) {
			continue;
		}
		headers[key] = Array.isArray(value) ? value.join(', ') : value;
	}
	return headers;
}

/** Preserve the query string: `?history=no`, `?snapshot-utxo=no`, `?address=`. */
function upstreamPath(originalUrl: string, subPath: string): string {
	const queryIndex = originalUrl.indexOf('?');
	return queryIndex === -1 ? subPath : `${subPath}${originalUrl.slice(queryIndex)}`;
}

export function proxyHttp(
	request: IncomingMessage,
	response: ServerResponse,
	apiPort: number,
	subPath: string,
	onError: (message: string) => void,
): void {
	const upstream = httpRequest(
		{
			host: LOOPBACK,
			port: apiPort,
			method: request.method,
			path: upstreamPath(request.url ?? subPath, subPath),
			headers: forwardableHeaders(request.headers),
		},
		(upstreamResponse) => {
			response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
			// Streamed, never collected.
			upstreamResponse.pipe(response);
		},
	);

	upstream.on('error', (error: Error) => {
		onError(`proxy to node api port ${apiPort} failed: ${error.message}`);
		if (!response.headersSent) {
			response.writeHead(502, { 'Content-Type': 'application/json' });
		}
		response.end(JSON.stringify({ error: 'node is not reachable' }));
	});

	request.on('aborted', () => upstream.destroy());
	request.pipe(upstream);
}

/**
 * Tunnel a WebSocket upgrade to the node.
 *
 * The upgrade is re-issued upstream rather than hand-rolled, so the node
 * performs the real handshake (including its own `Sec-WebSocket-Accept`) and we
 * only splice the resulting sockets together.
 */
export function proxyWebSocket(
	request: IncomingMessage,
	clientSocket: UpgradeSocket,
	head: Buffer,
	apiPort: number,
	subPath: string,
	onError: (message: string) => void,
): void {
	const upstream = httpRequest({
		host: LOOPBACK,
		port: apiPort,
		method: 'GET',
		path: upstreamPath(request.url ?? subPath, subPath),
		headers: {
			...forwardableHeaders(request.headers),
			Connection: 'Upgrade',
			Upgrade: 'websocket',
		},
	});

	const fail = (message: string): void => {
		onError(message);
		if (!clientSocket.destroyed) {
			clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
			clientSocket.destroy();
		}
	};

	upstream.on('upgrade', (upstreamResponse, upstreamSocket, upstreamHead) => {
		// A quiet head can be silent for a long time, and the full-history replay
		// can be slow; neither side may time the socket out.
		clientSocket.setTimeout?.(0);
		upstreamSocket.setTimeout?.(0);
		clientSocket.setNoDelay?.(true);
		upstreamSocket.setNoDelay?.(true);

		const statusLine = ['HTTP/1.1 101 Switching Protocols'];
		for (const [key, value] of Object.entries(upstreamResponse.headers)) {
			if (value === undefined) {
				continue;
			}
			statusLine.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
		}
		clientSocket.write(`${statusLine.join('\r\n')}\r\n\r\n`);

		if (upstreamHead.length > 0) {
			clientSocket.write(upstreamHead);
		}
		if (head.length > 0) {
			upstreamSocket.write(head);
		}

		const teardown = (): void => {
			upstreamSocket.destroy();
			clientSocket.destroy();
		};
		upstreamSocket.on('error', teardown);
		clientSocket.on('error', teardown);
		upstreamSocket.on('close', teardown);
		clientSocket.on('close', teardown);

		upstreamSocket.pipe(clientSocket);
		clientSocket.pipe(upstreamSocket);
	});

	upstream.on('response', () => {
		// The node answered without upgrading — it is not speaking WebSocket here.
		fail(`node api port ${apiPort} refused the websocket upgrade`);
	});
	upstream.on('error', (error: Error) => fail(`websocket proxy to port ${apiPort} failed: ${error.message}`));

	upstream.end();
}
