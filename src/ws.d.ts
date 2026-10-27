declare module 'ws' {
	import { EventEmitter } from 'node:events';

	export type RawData = Buffer | ArrayBuffer | Buffer[];

	export interface ClientOptions {
		maxPayload?: number;
		perMessageDeflate?: boolean;
		/**
		 * Sent on the upgrade request. Needed when a node sits behind a Hydra
		 * Host, which authenticates the upgrade itself.
		 */
		headers?: Record<string, string>;
	}

	export default class WebSocket extends EventEmitter {
		static readonly CONNECTING: number;
		static readonly OPEN: number;
		static readonly CLOSING: number;
		static readonly CLOSED: number;

		constructor(address: string | URL, options?: ClientOptions);

		readonly readyState: number;

		send(data: string | Buffer, callback?: (error?: Error) => void): void;
		close(code?: number, data?: string | Buffer): void;
		terminate(): void;
		/** Stop reading from the socket; a no-op while connecting or closed. */
		pause(): void;
		resume(): void;
		/** Send a ping control frame; the peer's websocket stack answers with a pong. */
		ping(data?: string | Buffer): void;
		pong(data?: string | Buffer): void;
	}
}
