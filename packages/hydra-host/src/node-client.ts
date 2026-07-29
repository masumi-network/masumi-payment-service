/**
 * Thin client for one supervised hydra-node's API.
 *
 * Always talks to loopback: the node binds `127.0.0.1` and the only process in
 * a position to reach it is this supervisor, sharing the network namespace.
 * That is the property that keeps an unauthenticated API — one that can close a
 * head, and whose `GET /config` discloses signing-key paths — off the network.
 */

import WebSocket, { type RawData } from 'ws';
import { NodeResponseError, NodeUnreachableError } from './errors.js';
import { getOwnValue, isPlainObject } from './registry/json.js';
import type { LastSeenSnapshotResponse } from './supervisor/drain.js';

const LOOPBACK = '127.0.0.1';

function decode(data: RawData): string {
	if (Buffer.isBuffer(data)) {
		return data.toString('utf8');
	}
	if (Array.isArray(data)) {
		return Buffer.concat(data).toString('utf8');
	}
	return Buffer.from(data).toString('utf8');
}

export class NodeClient {
	private readonly base: string;
	private readonly wsUrl: string;

	constructor(private readonly apiPort: number) {
		this.base = `http://${LOOPBACK}:${apiPort}`;
		this.wsUrl = `ws://${LOOPBACK}:${apiPort}`;
	}

	/**
	 * Errors are split deliberately: a transport failure means the node is gone,
	 * while a bad status or unparseable body means it is alive and answering
	 * badly. Draining branches on that difference.
	 */
	private async request(path: string, init?: RequestInit, timeoutMs = 10_000): Promise<unknown> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		let response: Response;
		try {
			response = await fetch(`${this.base}${path}`, { ...init, signal: controller.signal });
		} catch (error) {
			throw new NodeUnreachableError(
				`${init?.method ?? 'GET'} ${path} could not reach the node: ${(error as Error).message}`,
			);
		} finally {
			clearTimeout(timer);
		}

		if (!response.ok) {
			throw new NodeResponseError(`${init?.method ?? 'GET'} ${path} returned ${response.status}`);
		}
		const text = await response.text();
		if (text.length === 0) {
			return null;
		}
		try {
			return JSON.parse(text);
		} catch {
			throw new NodeResponseError(`${init?.method ?? 'GET'} ${path} returned a body that is not JSON`);
		}
	}

	/** Cheap liveness check; also the first thing that answers once a node is up. */
	async isResponsive(): Promise<boolean> {
		try {
			await this.request('/protocol-parameters', undefined, 5_000);
			return true;
		} catch {
			return false;
		}
	}

	async fetchLastSeen(): Promise<LastSeenSnapshotResponse> {
		const body = await this.request('/snapshot/last-seen');
		return isPlainObject(body) ? (body as LastSeenSnapshotResponse) : {};
	}

	async fetchConfirmedSnapshot(): Promise<unknown> {
		return this.request('/snapshot');
	}

	async sideLoadSnapshot(snapshot: unknown): Promise<void> {
		await this.request('/snapshot', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(snapshot),
		});
	}

	/**
	 * Read the head's current L1 slot from the `Greetings` frame the node sends
	 * on connect. Used for drift, so the supervisor never has to parse log files
	 * — the same technique the payment service uses to keep its head clock fresh.
	 */
	probeCurrentSlot(timeoutMs = 8_000): Promise<number | null> {
		return new Promise<number | null>((resolve) => {
			let settled = false;
			const finish = (value: number | null) => {
				if (settled) {
					return;
				}
				settled = true;
				try {
					socket.close();
				} catch {
					// ignore
				}
				resolve(value);
			};

			const socket = new WebSocket(`${this.wsUrl}?history=no`);
			const timer = setTimeout(() => finish(null), timeoutMs);
			timer.unref?.();

			socket.on('message', (data: RawData) => {
				let parsed: unknown;
				try {
					parsed = JSON.parse(decode(data));
				} catch {
					return;
				}
				if (!isPlainObject(parsed) || getOwnValue(parsed, 'tag') !== 'Greetings') {
					return;
				}
				if (getOwnValue(parsed, 'chainSyncedStatus') !== 'InSync') {
					return finish(null);
				}
				const slot = getOwnValue(parsed, 'currentSlot');
				finish(typeof slot === 'number' && Number.isSafeInteger(slot) && slot >= 0 ? slot : null);
			});
			socket.on('error', () => finish(null));
			socket.on('close', () => finish(null));
		});
	}
}
