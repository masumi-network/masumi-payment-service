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

	export type RawData = Buffer | ArrayBuffer | Buffer[];

	export interface ClientOptions {
		maxPayload?: number;
		perMessageDeflate?: boolean;
	}

	export default class WebSocket extends EventEmitter {
		constructor(address: string | URL, options?: ClientOptions);
		readonly readyState: number;
		close(code?: number, data?: string | Buffer): void;
		terminate(): void;
		send(data: string | Buffer): void;
	}
}
