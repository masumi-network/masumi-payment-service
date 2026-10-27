/**
 * Ambient declaration for `ws`.
 *
 * The package ships no types and `@types/ws` is not installed in this repo.
 * The payment service solves this with `src/ws.d.ts`, but the Hydra Host must
 * build standalone inside its container — depending on a declaration owned by
 * the service would reintroduce exactly the coupling this package avoids.
 *
 * Only the surface `node-client.ts` uses is declared.
 */
declare module 'ws' {
	import { EventEmitter } from 'node:events';
	import type { IncomingMessage } from 'node:http';
	import type { Duplex } from 'node:stream';

	export type RawData = Buffer | ArrayBuffer | Buffer[];

	export interface ClientOptions {
		maxPayload?: number;
		perMessageDeflate?: boolean;
		autoPong?: boolean;
		handshakeTimeout?: number;
	}

	export default class WebSocket extends EventEmitter {
		static readonly OPEN: number;
		constructor(address: string | URL, options?: ClientOptions);
		readonly readyState: number;
		close(code?: number, data?: string | Buffer): void;
		terminate(): void;
		send(data: string | Buffer, callback?: (error?: Error) => void): void;
		ping(data?: string | Buffer): void;
		pong(data?: string | Buffer): void;
	}

	export function createWebSocketStream(
		socket: WebSocket,
		options?: {
			readableObjectMode?: boolean;
			readableHighWaterMark?: number;
		},
	): Duplex;

	/**
	 * Only used by tests, which stand up a WebSocket-capable stand-in for
	 * hydra-node to prove the tunnel really upgrades rather than assuming it.
	 */
	export class WebSocketServer extends EventEmitter {
		constructor(options: {
			server?: unknown;
			port?: number;
			noServer?: boolean;
			perMessageDeflate?: boolean;
			autoPong?: boolean;
			maxPayload?: number;
		});
		handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, callback: (socket: WebSocket) => void): void;
		close(callback?: () => void): void;
	}
}
