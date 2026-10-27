/**
 * Reverse proxy onto a supervised node's own API.
 *
 * The node binds loopback and has no authentication, so this is the only path
 * to it — the token check happens before anything here runs, and the allow-list
 * in `proxy-path.ts` decides what may be forwarded at all.
 *
 * Two behaviours are load-bearing and easy to lose to a "sensible default":
 *
 *  - **History is streamed with backpressure.** The payment service replays
 *    the full event log over a WebSocket (`?history=yes`). Each message is
 *    bounded, and a slow reader pauses the upstream instead of collecting it.
 *  - **Idle timeouts are disabled on proxied connections.** A quiet head sends
 *    nothing for long stretches, and the control plane's own short timeouts
 *    (which exist to bound ordinary requests) would tear those sockets down.
 */

import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { Transform, type Duplex } from 'node:stream';
import WebSocket, { WebSocketServer, createWebSocketStream } from 'ws';

/**
 * The upgrade socket is a `net.Socket` at runtime, but `server.on('upgrade')`
 * types it as a bare `Duplex`. Declaring the two methods we need as optional is
 * honest about that gap without casting away the type.
 */
type UpgradeSocket = Duplex & Partial<Pick<Socket, 'setTimeout' | 'setNoDelay'>>;

const LOOPBACK = '127.0.0.1';
const PRE_DISPATCH_ERROR_HEADER = 'x-hydra-host-proxy-error';
const NODE_NOT_CONNECTED = 'node-not-connected';
const MAX_WS_MESSAGE_BYTES = 4 * 1024 * 1024;
const INIT_DISPATCH_TIMEOUT_MS = 10_000;
const WS_DRAIN_GRACE_MS = 30_000;

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

/**
 * The upstream request target.
 *
 * The query arrives already rebuilt from `buildProxyQuery`'s allow-list, so
 * this only joins it. Taking it from `request.url` here instead is what let the
 * caller's whole query through to an unauthenticated API.
 */
function upstreamPath(subPath: string, query: string): string {
	return `${subPath}${query}`;
}

export function proxyHttp(
	request: IncomingMessage,
	response: ServerResponse,
	apiPort: number,
	subPath: string,
	query: string,
	onError: (message: string) => void,
): void {
	// The caller can hang up while the handler still reads the node's record.
	// The response's 'close' has fired by then, so the listener below would
	// never run. The node got a connection that stayed open with no request on
	// it, since piping a destroyed request never ends the node's request. A
	// pipelined request's response waits in a queue without a socket, and some
	// Node versions never destroy it, so its destroyed request is the signal.
	if (response.destroyed || request.destroyed) return;
	// Stripping Transfer-Encoding while piping a GET or DELETE body leaves the
	// upstream request unframed. Its bytes could be parsed as another request.
	if (
		(request.method === 'GET' || request.method === 'DELETE') &&
		(request.headers['transfer-encoding'] !== undefined ||
			(request.headers['content-length'] !== undefined && request.headers['content-length'] !== '0'))
	) {
		response.writeHead(400, {
			'Content-Type': 'application/json',
			'Cache-Control': 'no-store',
			Connection: 'close',
		});
		response.end(JSON.stringify({ error: 'GET and DELETE node API requests must not have a body' }));
		return;
	}
	const upstream = httpRequest(
		{
			host: LOOPBACK,
			port: apiPort,
			method: request.method,
			path: upstreamPath(subPath, query),
			headers: forwardableHeaders(request.headers),
		},
		(upstreamResponse) => {
			// A same-name upstream header would beat the handler's setHeader in
			// writeHead's merge, so strip it to keep the noindex stamp authoritative.
			const headers = { ...upstreamResponse.headers };
			delete headers['x-robots-tag'];
			// Only the Host may attest that a request never reached the node.
			delete headers[PRE_DISPATCH_ERROR_HEADER];
			response.writeHead(upstreamResponse.statusCode ?? 502, headers);
			// A node that closes the connection mid-body fails only this response,
			// and pipe() does not pass that on: the caller's response stayed open,
			// unlogged, until the caller's own timeout. Cut it instead. A reset
			// fails the request first, and its handler has already logged and cut
			// the response. A caller that hung up lands here too, and that is no
			// node failure. Either way there is nothing left to report.
			upstreamResponse.on('error', (error: Error) => {
				if (response.destroyed) return;
				onError(`proxy to node api port ${apiPort} failed mid-response: ${error.message}`);
				response.destroy();
			});
			// Streamed, never collected.
			upstreamResponse.pipe(response);
		},
	);

	upstream.on('error', (error: Error) => {
		// A caller that hung up is not a node failure.
		if (response.destroyed) return;
		onError(`proxy to node api port ${apiPort} failed: ${error.message}`);
		// Once writeHead has run, the node's status is committed, so a body
		// appended here would read as the node's own complete answer.
		if (response.headersSent) {
			response.destroy();
			return;
		}
		// ECONNREFUSED from the loopback connect means the node accepted no
		// connection. A reset after connect is still ambiguous for mutations.
		const wasNotConnected = (error as NodeJS.ErrnoException).code === 'ECONNREFUSED';
		response.writeHead(502, {
			'Content-Type': 'application/json',
			...(wasNotConnected ? { [PRE_DISPATCH_ERROR_HEADER]: NODE_NOT_CONNECTED } : {}),
		});
		response.end(JSON.stringify({ error: 'node is not reachable' }));
	});

	request.on('aborted', () => upstream.destroy());
	// 'aborted' only covers a request still being read. A caller that hung up
	// after that left the node's connection open: until the node answered, or
	// for good mid-body, where pipe() pauses on the dead response.
	response.on('close', () => {
		if (!response.writableFinished) upstream.destroy();
	});
	request.pipe(upstream);
}

/** One request opens one loopback session and sends one privileged Init. */
export function dispatchInit(apiPort: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(`ws://${LOOPBACK}:${apiPort}/?history=no`, {
			perMessageDeflate: false,
			maxPayload: MAX_WS_MESSAGE_BYTES,
			handshakeTimeout: INIT_DISPATCH_TIMEOUT_MS,
		});
		let settled = false;
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) {
				socket.terminate();
				reject(error);
			} else {
				socket.close();
				resolve();
			}
		};
		const timer = setTimeout(
			() => finish(new Error('node Init websocket did not accept the command in time')),
			INIT_DISPATCH_TIMEOUT_MS,
		);
		socket.once('open', () => socket.send(JSON.stringify({ tag: 'Init' }), (error) => finish(error)));
		socket.once('error', (error: unknown) =>
			finish(error instanceof Error ? error : new Error('node Init websocket failed')),
		);
		socket.once('close', () => finish(new Error('node Init websocket closed before command dispatch')));
	});
}

/**
 * Forward parsed, bounded WebSocket messages. The node's full history remains
 * streamed with backpressure; Init is reserved for the admin-only route above.
 */
export function proxyWebSocket(
	request: IncomingMessage,
	clientSocket: UpgradeSocket,
	head: Buffer,
	apiPort: number,
	subPath: string,
	query: string,
	onError: (message: string) => void,
): void {
	const upstream = new WebSocket(`ws://${LOOPBACK}:${apiPort}${upstreamPath(subPath, query)}`, {
		perMessageDeflate: false,
		autoPong: false,
		maxPayload: MAX_WS_MESSAGE_BYTES,
		handshakeTimeout: INIT_DISPATCH_TIMEOUT_MS,
	});
	let upgraded = false;
	let failed = false;
	// Before the upgrade, ws emits both 'error' and 'close'. A second end() on
	// the client socket raises an unhandled write-after-end error.
	const fail = (message: string): void => {
		if (failed || clientSocket.destroyed) return;
		failed = true;
		onError(message);
		if (upgraded) {
			clientSocket.destroy();
		} else {
			clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
		}
	};
	clientSocket.once('close', () => upstream.terminate());
	upstream.once('error', (error: unknown) =>
		fail(`websocket proxy to port ${apiPort} failed: ${error instanceof Error ? error.message : 'unknown error'}`),
	);
	upstream.once('close', () => {
		if (!upgraded) {
			fail(`node api port ${apiPort} closed the websocket upgrade`);
			return;
		}
		// createWebSocketStream ends the client only after queued history frames
		// drain. A stalled reader cannot keep this closed node session forever.
		const timer = setTimeout(() => clientSocket.destroy(), WS_DRAIN_GRACE_MS);
		timer.unref();
		clientSocket.once('close', () => clearTimeout(timer));
	});
	upstream.once('open', () => {
		if (clientSocket.destroyed) return upstream.terminate();
		clientSocket.setTimeout?.(0);
		clientSocket.setNoDelay?.(true);
		const server = new WebSocketServer({
			noServer: true,
			perMessageDeflate: false,
			autoPong: false,
			maxPayload: MAX_WS_MESSAGE_BYTES,
		});
		try {
			server.handleUpgrade(request, clientSocket, head, (client) => {
				upgraded = true;
				// Text messages read as strings. Without decodeStrings: false the
				// writable side turns them into Buffers, which ws sends as binary frames.
				const streamOptions = { readableObjectMode: true, readableHighWaterMark: 1, decodeStrings: false };
				const clientStream = createWebSocketStream(client, streamOptions);
				const upstreamStream = createWebSocketStream(upstream, streamOptions);
				const commandGate = new Transform({
					writableObjectMode: true,
					readableObjectMode: true,
					readableHighWaterMark: 1,
					writableHighWaterMark: 1,
					transform(chunk: unknown, _encoding, callback) {
						if (typeof chunk !== 'string') {
							client.close(1003, 'text commands required');
							upstream.terminate();
							callback();
							return;
						}
						let command: unknown;
						try {
							command = JSON.parse(chunk);
						} catch {
							client.close(1007, 'invalid JSON command');
							upstream.terminate();
							callback();
							return;
						}
						if (typeof command !== 'object' || command === null || Array.isArray(command)) {
							client.close(1008, 'invalid command');
							upstream.terminate();
							callback();
							return;
						}
						if ((command as { tag?: unknown }).tag === 'Init') {
							onError('blocked Init on ordinary node websocket');
							client.close(1008, 'Init requires admitted route');
							upstream.terminate();
							callback();
							return;
						}
						// Re-encoding removes duplicate JSON keys, including a hidden first
						// `tag` that another parser could interpret as Init.
						callback(null, JSON.stringify(command));
					},
				});
				const teardown = (): void => {
					client.terminate();
					upstream.terminate();
				};
				// The payment client counts node pongs as liveness. Each hop must
				// relay control frames, never answer a ping on the node's behalf.
				const relayControl = (target: WebSocket, kind: 'ping' | 'pong', data: Buffer): void => {
					if (target.readyState !== WebSocket.OPEN) return;
					try {
						target[kind](data);
					} catch {
						teardown();
					}
				};
				client.on('ping', (data: Buffer) => relayControl(upstream, 'ping', data));
				client.on('pong', (data: Buffer) => relayControl(upstream, 'pong', data));
				upstream.on('ping', (data: Buffer) => relayControl(client, 'ping', data));
				upstream.on('pong', (data: Buffer) => relayControl(client, 'pong', data));
				client.once('close', teardown);
				clientStream.once('error', teardown);
				upstreamStream.once('error', teardown);
				commandGate.once('error', teardown);
				clientStream.pipe(commandGate).pipe(upstreamStream);
				upstreamStream.pipe(clientStream);
			});
		} catch (error) {
			upstream.terminate();
			fail(`websocket client upgrade failed: ${(error as Error).message}`);
		}
	});
}
