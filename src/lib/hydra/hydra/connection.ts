import { EventEmitter } from 'node:events';
import { errorToString } from '@/utils/converter/error-string-convert';
import { jsonToString } from '@/utils/converter/json-to-string';
import { HydraHeadStatus } from '@/generated/prisma/client';

export class Connection extends EventEmitter {
	private _url: string;
	private _status: HydraHeadStatus;
	private _websocket: WebSocket | undefined;

	constructor(url: string) {
		super();
		this._url = url;
		this._status = HydraHeadStatus.Disconnected;
		this.setMaxListeners(10000);
	}

	async connect() {
		if (this._status !== HydraHeadStatus.Disconnected) {
			return;
		}

		this._websocket = new WebSocket(this._url.replace('http', 'ws'));
		this._status = HydraHeadStatus.Connecting;

		this._websocket.onopen = () => {
			this._status = HydraHeadStatus.Connected;
		};

		this._websocket.onerror = (error) => {
			console.error(`Received error: ${errorToString(error)}`);
		};

		this._websocket.onclose = (event) => {
			if (event.code === 1006) {
				void this.onerror(new Error('Connection closed unexpectedly'));
			}
		};

		this._websocket.onmessage = (event) => {
			this.emit('message', event.data as string);
		};
	}

	async onerror(error: Error) {
		if (this._status === HydraHeadStatus.Idle) {
			return;
		}

		if (this._status === HydraHeadStatus.Connected) {
			this._status = HydraHeadStatus.Connecting;
			this.emit('close', error);
		}

		console.error(`Error: ${error}`);

		setTimeout(() => {
			void this.connect();
		}, 1000);
	}

	async disconnect() {
		if (this._status === HydraHeadStatus.Disconnected) {
			return;
		}

		if (this._websocket && this._websocket.readyState === WebSocket.OPEN) {
			this._websocket.close(1007);
		}
		this._status = HydraHeadStatus.Disconnected;
	}

	isOpen(): boolean {
		return this._status === HydraHeadStatus.Connected;
	}

	send(data: unknown): void {
		let sent = false;

		const sendData = () => {
			if (this._websocket?.readyState === WebSocket.OPEN) {
				this._websocket.send(jsonToString(data));
				sent = true;
				return true;
			}
			return false;
		};

		const interval = setInterval(() => {
			if (!sent && sendData()) {
				clearInterval(interval);
				clearTimeout(timeout);
			}
		}, 1000);

		const timeout = setTimeout(() => {
			if (!sent) {
				console.error(`Hydra websocket failed to send ${jsonToString(data)}`);
				clearInterval(interval);
			}
		}, 5000);
	}
}
