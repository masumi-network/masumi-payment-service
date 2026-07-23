import { EventEmitter } from 'node:events';
import { errorToString } from '@masumi/payment-core/error-string-convert';
import { logger } from '@masumi/payment-core/logger';
import WebSocket, { type RawData } from 'ws';
import { stringifyHydraJson } from './json';
import { HydraHeadStatus } from '@/generated/prisma/client';
import { HydraProtocolError, HydraTransportError } from './errors';
import { MAX_HYDRA_WS_FRAME_BYTES } from './schemas';

const SEND_TIMEOUT_MS = 5000;
const SEND_RETRY_INTERVAL_MS = 100;
const OPEN_TIMEOUT_MS = 10_000;
const DISCONNECT_GRACE_TIMEOUT_MS = 1_000;
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const RECONNECT_JITTER_RATIO = 0.2;

export class Connection extends EventEmitter {
	private _url: string;
	private _status: HydraHeadStatus;
	private _websocket: WebSocket | undefined;
	private _reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private _isManuallyDisconnected = false;
	private _isDisconnecting = false;
	private _disconnectPromise: Promise<void> | undefined;
	private _socketGeneration = 0;
	private _reconnectAttempt = 0;

	constructor(url: string) {
		super();
		this._url = url;
		this._status = HydraHeadStatus.Disconnected;
	}

	async connect() {
		if (this._status !== HydraHeadStatus.Disconnected || this._isDisconnecting) {
			return;
		}

		this._isManuallyDisconnected = false;
		const generation = ++this._socketGeneration;
		// `ws` enforces maxPayload inside its receiver, before a complete oversized
		// message is assembled for application code. Disable compression so the same
		// explicit byte budget applies without a decompression stage.
		const websocket = new WebSocket(this._url.replace('http', 'ws'), {
			maxPayload: MAX_HYDRA_WS_FRAME_BYTES,
			perMessageDeflate: false,
		});
		this._websocket = websocket;
		this._status = HydraHeadStatus.Connecting;

		websocket.on('open', () => {
			if (generation !== this._socketGeneration || this._isManuallyDisconnected) return;
			this._reconnectAttempt = 0;
			this._status = HydraHeadStatus.Connected;
			this.safeEmit('open');
		});

		websocket.on('error', (error: Error) => {
			if (generation !== this._socketGeneration || this._isManuallyDisconnected) return;
			this.handleTransportFailure(
				new HydraTransportError(`WebSocket error: ${errorToString(error)}`),
				websocket,
				generation,
			);
		});

		websocket.on('close', (code: number) => {
			if (generation !== this._socketGeneration || this._isManuallyDisconnected) return;
			this.handleTransportFailure(
				new HydraTransportError(`Connection closed unexpectedly (code ${code})`),
				websocket,
				generation,
			);
		});

		websocket.on('message', (data: RawData, isBinary: boolean) => {
			// Graceful teardown deliberately keeps processing current-generation text
			// frames until the peer closes. Hydra can report a final authenticated L1
			// rollback while the close handshake is in flight, and the manager must be
			// able to persist that frame before removing its listeners.
			if (generation !== this._socketGeneration || (this._isManuallyDisconnected && !this._isDisconnecting)) {
				return;
			}
			if (isBinary) {
				this.handleTransportFailure(
					new HydraProtocolError('Hydra websocket sent a non-text frame'),
					websocket,
					generation,
				);
				return;
			}
			const text = rawWebSocketDataToText(data);
			if (Buffer.byteLength(text, 'utf8') > MAX_HYDRA_WS_FRAME_BYTES) {
				this.handleTransportFailure(
					new HydraProtocolError(`Hydra websocket frame exceeded ${MAX_HYDRA_WS_FRAME_BYTES} bytes`),
					websocket,
					generation,
				);
				return;
			}
			this.safeEmit('message', text);
		});
	}

	waitUntilOpen(timeoutMs: number = OPEN_TIMEOUT_MS): Promise<void> {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
			return Promise.reject(new HydraTransportError('Hydra websocket open timeout must be a positive safe integer'));
		}
		if (this.isOpen()) return Promise.resolve();

		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const cleanup = () => {
				clearTimeout(timeout);
				this.removeListener('open', handleOpen);
				this.removeListener('close', handleClose);
			};
			const settle = (error?: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				if (error) reject(error);
				else resolve();
			};
			const handleOpen = () => settle();
			const handleClose = (reason: unknown) => {
				settle(
					reason instanceof HydraTransportError
						? reason
						: new HydraTransportError('Hydra websocket failed before opening', { cause: reason }),
				);
			};
			const timeout = setTimeout(() => {
				settle(new HydraTransportError(`Hydra websocket did not open within ${timeoutMs}ms`));
			}, timeoutMs);

			this.on('open', handleOpen);
			this.on('close', handleClose);
			void this.connect().catch((error: unknown) => {
				settle(new HydraTransportError('Hydra websocket could not be created', { cause: error }));
			});
			if (this.isOpen()) settle();
		});
	}

	private safeEmit(eventName: string, ...args: unknown[]): void {
		try {
			this.emit(eventName, ...args);
		} catch (error) {
			logger.error('[HydraConnection] Event listener failed', {
				eventName,
				error: errorToString(error),
			});
		}
	}

	private handleTransportFailure(error: Error, websocket: WebSocket, generation: number) {
		if (generation !== this._socketGeneration) return;
		if (this._status === HydraHeadStatus.Idle || this._isManuallyDisconnected) {
			return;
		}

		// Invalidate this socket before closing it so its subsequent callbacks cannot
		// race the replacement socket or schedule another reconnect.
		this._socketGeneration += 1;
		if (this._websocket === websocket) this._websocket = undefined;
		if (this._status !== HydraHeadStatus.Disconnected) {
			this.safeEmit('close', error);
		}
		this._status = HydraHeadStatus.Disconnected;

		websocket.removeAllListeners('open');
		websocket.removeAllListeners('error');
		// `ws` treats an unhandled later `error` event as a process exception.
		// The socket is generation-invalidated, so safely absorb only its stale errors.
		websocket.on('error', () => undefined);
		websocket.removeAllListeners('close');
		websocket.removeAllListeners('message');
		if (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING) {
			try {
				websocket.close(1011);
			} catch {
				// The failed socket is already unusable; generation invalidation is enough.
			}
		}

		logger.error('[HydraConnection] Transport failed', { error: error.message });

		if (!this._reconnectTimer) {
			const exponentialDelay = Math.min(
				MAX_RECONNECT_DELAY_MS,
				INITIAL_RECONNECT_DELAY_MS * 2 ** Math.min(this._reconnectAttempt, 10),
			);
			this._reconnectAttempt += 1;
			const jitterMultiplier = 1 + (Math.random() * 2 - 1) * RECONNECT_JITTER_RATIO;
			const reconnectDelay = Math.max(
				100,
				Math.min(MAX_RECONNECT_DELAY_MS, Math.round(exponentialDelay * jitterMultiplier)),
			);
			this._reconnectTimer = setTimeout(() => {
				this._reconnectTimer = undefined;
				if (!this._isManuallyDisconnected) {
					void this.connect().catch((reconnectError: unknown) => {
						logger.error('[HydraConnection] Reconnect attempt failed', {
							error: errorToString(reconnectError),
						});
					});
				}
			}, reconnectDelay);
			this._reconnectTimer.unref?.();
		}
	}

	async disconnect(): Promise<void> {
		if (this._disconnectPromise) return await this._disconnectPromise;
		const disconnectPromise = this.disconnectCurrentSocket();
		this._disconnectPromise = disconnectPromise;
		try {
			await disconnectPromise;
		} finally {
			if (this._disconnectPromise === disconnectPromise) this._disconnectPromise = undefined;
		}
	}

	private async disconnectCurrentSocket(): Promise<void> {
		const hadActiveSocket = this._websocket != null || this._status !== HydraHeadStatus.Disconnected;
		const websocket = this._websocket;
		const generation = this._socketGeneration;
		this._isManuallyDisconnected = true;
		this._isDisconnecting = true;
		if (this._reconnectTimer) {
			clearTimeout(this._reconnectTimer);
			this._reconnectTimer = undefined;
		}

		try {
			if (websocket) await closeWebSocketGracefully(websocket);
		} finally {
			// Invalidate only after the close handshake (or bounded termination), so
			// current-generation message callbacks remain live throughout the drain.
			if (this._socketGeneration === generation) this._socketGeneration += 1;
			if (this._websocket === websocket) this._websocket = undefined;
			this._status = HydraHeadStatus.Disconnected;
			this._reconnectAttempt = 0;
			this._isDisconnecting = false;
			if (hadActiveSocket) {
				this.safeEmit('close', new HydraTransportError('Hydra websocket was disconnected'));
			}
		}
	}

	isOpen(): boolean {
		return this._status === HydraHeadStatus.Connected;
	}

	invalidate(error: Error): void {
		const websocket = this._websocket;
		if (!websocket) return;
		this.handleTransportFailure(error, websocket, this._socketGeneration);
	}

	send(data: unknown): Promise<void> {
		if (this._isManuallyDisconnected || this._isDisconnecting) {
			return Promise.reject(new HydraTransportError('Hydra websocket is disconnecting; command not sent'));
		}
		let serializedData: string;
		try {
			serializedData = stringifyHydraJson(data);
		} catch (error) {
			return Promise.reject(new HydraTransportError('Hydra command could not be serialized', { cause: error }));
		}
		if (Buffer.byteLength(serializedData, 'utf8') > MAX_HYDRA_WS_FRAME_BYTES) {
			return Promise.reject(
				new HydraTransportError(`Hydra command exceeded ${MAX_HYDRA_WS_FRAME_BYTES} bytes and was not sent`),
			);
		}

		return new Promise<void>((resolve, reject) => {
			const timers: {
				interval?: ReturnType<typeof setInterval>;
				timeout?: ReturnType<typeof setTimeout>;
			} = {};
			let settled = false;

			const cleanup = () => {
				if (timers.interval) clearInterval(timers.interval);
				if (timers.timeout) clearTimeout(timers.timeout);
				this.removeListener('close', handleClose);
			};
			const settle = (error?: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				if (error) reject(error);
				else resolve();
			};
			const trySend = () => {
				if (this._isManuallyDisconnected || this._isDisconnecting) {
					settle(new HydraTransportError('Hydra websocket is disconnecting; command not sent'));
					return;
				}
				const websocket = this._websocket;
				if (websocket?.readyState !== WebSocket.OPEN) return;
				try {
					websocket.send(serializedData);
					settle();
				} catch (error) {
					settle(
						new HydraTransportError('Hydra websocket rejected the command before it was queued', { cause: error }),
					);
				}
			};
			const handleClose = (error: unknown) => {
				settle(
					new HydraTransportError('Hydra websocket closed before the command could be queued', {
						cause: error,
					}),
				);
			};

			this.on('close', handleClose);
			trySend();
			if (settled) return;
			timers.interval = setInterval(trySend, SEND_RETRY_INTERVAL_MS);
			timers.timeout = setTimeout(() => {
				settle(new HydraTransportError(`Hydra websocket did not open within ${SEND_TIMEOUT_MS}ms; command not sent`));
			}, SEND_TIMEOUT_MS);
		});
	}
}

async function closeWebSocketGracefully(websocket: WebSocket): Promise<void> {
	if (websocket.readyState === WebSocket.CLOSED) return;

	await new Promise<void>((resolve) => {
		let settled = false;
		const settle = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			websocket.removeListener('close', settle);
			resolve();
		};
		const timeout = setTimeout(() => {
			try {
				websocket.terminate();
			} catch {
				// Generation invalidation below is the final containment boundary.
			}
			settle();
		}, DISCONNECT_GRACE_TIMEOUT_MS);
		timeout.unref?.();
		websocket.on('close', settle);

		if (websocket.readyState === WebSocket.OPEN || websocket.readyState === WebSocket.CONNECTING) {
			try {
				websocket.close(1000);
			} catch {
				try {
					websocket.terminate();
				} finally {
					settle();
				}
			}
		}
	});
}

function rawWebSocketDataToText(data: RawData): string {
	if (Buffer.isBuffer(data)) return data.toString('utf8');
	if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
	return Buffer.concat(data).toString('utf8');
}
