/**
 * The Control Plane HTTP client: how this service talks to one Hydra Host's
 * HTTP endpoint, and nothing else.
 *
 * Owns the URL, the bearer credential, the request timeout, the bounded
 * payload rule, and the one semantic that callers keep getting wrong without
 * it: a POST or DELETE whose response is lost is *ambiguous*, not failed —
 * the node may well have acted on it. GETs stay plain failures.
 */

import { stringifyHydraJson } from './json';
import { HydraProtocolError, HydraTransportAmbiguousError, HydraTransportError } from './errors';
import { HydraHttpResponseError, handleHttpResponse } from './node-frames';
import { MAX_HYDRA_WS_FRAME_BYTES } from './schemas';

export class HydraHttpClient {
	private readonly _httpUrl: string;
	private readonly _authHeaders: Record<string, string>;
	private readonly _timeoutMs: number;

	constructor(config: { httpUrl: string; authHeaders: Record<string, string>; timeoutMs: number }) {
		this._httpUrl = config.httpUrl;
		this._authHeaders = config.authHeaders;
		this._timeoutMs = config.timeoutMs;
	}

	async get<T = unknown>(url: string): Promise<T> {
		return await this.request<T>('GET', url);
	}

	async post<T = unknown>(url: string, payload: unknown): Promise<T> {
		return await this.request<T>('POST', url, payload);
	}

	async delete<T = unknown>(url: string): Promise<T> {
		return await this.request<T>('DELETE', url);
	}

	private async request<T>(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown): Promise<T> {
		let serializedPayload: string | undefined;
		if (method === 'POST') {
			try {
				serializedPayload = stringifyHydraJson(payload);
			} catch (error) {
				throw new HydraProtocolError('Hydra HTTP request payload could not be serialized', { cause: error });
			}
			if (Buffer.byteLength(serializedPayload, 'utf8') > MAX_HYDRA_WS_FRAME_BYTES) {
				throw new HydraProtocolError('Hydra HTTP request payload exceeded its byte limit');
			}
		}

		const abortController = new AbortController();
		let didTimeout = false;
		const timeout = setTimeout(() => {
			didTimeout = true;
			abortController.abort();
		}, this._timeoutMs);
		timeout.unref?.();
		try {
			const response = await fetch(this._httpUrl + url, {
				method,
				headers: { 'Content-Type': 'application/json', ...this._authHeaders },
				redirect: 'error',
				signal: abortController.signal,
				...(serializedPayload === undefined ? {} : { body: serializedPayload }),
			});
			try {
				return (await handleHttpResponse(response)) as T;
			} catch (error) {
				if (error instanceof HydraHttpResponseError) {
					if (method === 'GET' || error.status < 500) throw error;
					throw new HydraTransportAmbiguousError(
						`Hydra HTTP POST outcome is ambiguous after a ${error.status} response`,
						{ cause: error },
					);
				}
				if (method === 'GET') throw error;
				throw new HydraTransportAmbiguousError(
					'Hydra HTTP POST outcome is ambiguous because its response could not be authenticated',
					{ cause: error },
				);
			}
		} catch (error) {
			if (
				error instanceof HydraHttpResponseError ||
				error instanceof HydraTransportAmbiguousError ||
				error instanceof HydraProtocolError
			) {
				throw error;
			}
			// DELETE recovers a deposit by posting a transaction, so losing its
			// response is as ambiguous as losing a POST's: the node may well have
			// posted it. Reporting that as a plain failure told an operator their
			// recovery had not happened while it was on its way to the chain.
			if (method === 'POST' || method === 'DELETE') {
				throw new HydraTransportAmbiguousError(
					didTimeout
						? `Hydra HTTP ${method} outcome is ambiguous after a ${this._timeoutMs}ms timeout`
						: `Hydra HTTP ${method} outcome is ambiguous after a transport failure`,
					{ cause: error },
				);
			}
			throw new HydraTransportError(
				didTimeout
					? `Hydra HTTP GET timed out after ${this._timeoutMs}ms`
					: 'Hydra HTTP GET failed before a response was received',
				{ cause: error },
			);
		} finally {
			clearTimeout(timeout);
		}
	}
}
