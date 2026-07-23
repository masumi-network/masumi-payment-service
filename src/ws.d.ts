declare module 'ws' {
	import { EventEmitter } from 'node:events';

	export type RawData = Buffer | ArrayBuffer | Buffer[];

	export interface ClientOptions {
		maxPayload?: number;
		perMessageDeflate?: boolean;
	}

	export default class WebSocket extends EventEmitter {
		static readonly CONNECTING: number;
		static readonly OPEN: number;
		static readonly CLOSING: number;
		static readonly CLOSED: number;

		constructor(address: string | URL, options?: ClientOptions);

		readonly readyState: number;

		send(data: string): void;
		close(code?: number, data?: string | Buffer): void;
		terminate(): void;
	}
}
