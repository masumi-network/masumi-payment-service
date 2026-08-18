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

/**
 * What the node says about its chain view.
 *
 * `synced: false` covers both "still catching up" and "the probe failed" — from
 * the supervisor's point of view they are the same: the node cannot be trusted
 * to accept work yet.
 */
export type ChainProbe = { synced: boolean; slot: number | null };

/** Used only when the probe learns nothing at all: no answer, or no Greetings. */
const NOT_SYNCED: ChainProbe = { synced: false, slot: null };

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
		// The timeout stays armed across the BODY read, not just the headers.
		// `fetch` resolves the moment headers arrive, so clearing the timer there
		// left the body unbounded: a node that answered and then stopped writing
		// held a declared 5s probe for undici's `bodyTimeout` (300s, measured), and
		// because that timeout resets per chunk, a node dribbling one byte a minute
		// held it forever.
		//
		// Every supervisor probe comes through here from inside `runTick`, which
		// cannot resolve until all its workers do — so one stalled body stopped the
		// host reconciling EVERY node, not just that one, and then blocked SIGTERM
		// behind the same wait. A wedged node that answers headers and then goes
		// quiet is precisely what the supervisor exists to detect.
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			let response: Response;
			try {
				response = await fetch(`${this.base}${path}`, { ...init, signal: controller.signal });
			} catch (error) {
				throw new NodeUnreachableError(
					`${init?.method ?? 'GET'} ${path} could not reach the node: ${(error as Error).message}`,
				);
			}

			if (!response.ok) {
				throw new NodeResponseError(`${init?.method ?? 'GET'} ${path} returned ${response.status}`);
			}
			let text: string;
			try {
				text = await response.text();
			} catch (error) {
				// A body that stalls or stops mid-stream is the node going away, not
				// the node answering badly — drain branches on that difference.
				throw new NodeUnreachableError(
					`${init?.method ?? 'GET'} ${path} could not read the node's response: ${(error as Error).message}`,
				);
			}
			if (text.length === 0) {
				return null;
			}
			try {
				return JSON.parse(text);
			} catch {
				throw new NodeResponseError(`${init?.method ?? 'GET'} ${path} returned a body that is not JSON`);
			}
		} finally {
			clearTimeout(timer);
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
	 * Read chain sync state and the current L1 slot from the `Greetings` frame
	 * the node sends on connect, so the supervisor never has to parse log files —
	 * the same technique the payment service uses to keep its head clock fresh.
	 *
	 * Sync and slot are reported separately because they mean different things to
	 * a caller. A node that is answering but still catching up will accept a
	 * connection and then refuse every command with `WaitOnNodeInSync`; collapsing
	 * that into "no slot" made it indistinguishable from a failed probe, and left
	 * the node looking usable when it was not.
	 */
	probeChain(timeoutMs = 8_000): Promise<ChainProbe> {
		return new Promise<ChainProbe>((resolve) => {
			let settled = false;
			const finish = (value: ChainProbe) => {
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
			const timer = setTimeout(() => finish(NOT_SYNCED), timeoutMs);
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
				// The slot is read whether or not the node is in sync. A catching-up
				// node reports how far it has got, and that number is the only thing
				// that distinguishes "thirty seconds behind" from "fifteen hours
				// behind" — which is the difference between waiting and intervening.
				// Discarding it left every catching-up node reporting a null drift,
				// so the one measurement an operator needs was missing exactly when
				// it mattered.
				const slot = getOwnValue(parsed, 'currentSlot');
				const usable = typeof slot === 'number' && Number.isSafeInteger(slot) && slot >= 0;
				const synced = getOwnValue(parsed, 'chainSyncedStatus') === 'InSync';
				finish({ synced, slot: usable ? slot : null });
			});
			socket.on('error', () => finish(NOT_SYNCED));
			socket.on('close', () => finish(NOT_SYNCED));
		});
	}
}
