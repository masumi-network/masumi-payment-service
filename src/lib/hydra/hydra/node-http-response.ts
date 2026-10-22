/**
 * Reading a hydra-node HTTP response: bounding its body before parsing it, and
 * turning a refusal into an error that names the node's reason.
 *
 * Split from node-frames.ts, which had reached the 750-line limit. A leaf,
 * like that file: nothing here knows about the websocket session.
 */

import { HydraProtocolError } from './errors';
import { parseHydraJson, stringifyHydraJson } from './json';
import { postTxErrorTag } from './post-tx-error';

const MAX_HYDRA_HTTP_RESPONSE_BYTES = 4 * 1024 * 1024;

export class HydraHttpResponseError extends Error {
	override readonly name = 'HydraHttpResponseError';

	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

export async function handleHttpResponse(response: Response): Promise<unknown> {
	const responseText = await readBoundedHttpResponse(response);
	let responseBody: unknown;
	try {
		responseBody = parseHydraJson(responseText);
	} catch (error) {
		if (response.ok === false) throw createHttpResponseError(response);
		throw new HydraProtocolError('Hydra HTTP response was not valid JSON', { cause: error });
	}
	if (response.ok === false) throw createHttpResponseError(response, responseBody);
	return responseBody;
}

export async function readBoundedHttpResponse(response: Response): Promise<string> {
	if (response.body && typeof response.body.getReader === 'function') {
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let totalBytes = 0;
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			totalBytes += chunk.value.byteLength;
			if (totalBytes > MAX_HYDRA_HTTP_RESPONSE_BYTES) {
				await reader.cancel();
				throw new HydraProtocolError('Hydra HTTP response exceeded its byte limit');
			}
			chunks.push(chunk.value);
		}
		return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
	}

	let responseText: string;
	if (typeof response.text === 'function') {
		responseText = await response.text();
	} else if (typeof response.json === 'function') {
		try {
			responseText = stringifyHydraJson(await response.json());
		} catch (error) {
			throw new HydraProtocolError('Hydra HTTP response contained an inexact JSON number', { cause: error });
		}
	} else {
		throw new HydraProtocolError('Hydra HTTP response body was unavailable');
	}
	if (Buffer.byteLength(responseText, 'utf8') > MAX_HYDRA_HTTP_RESPONSE_BYTES) {
		throw new HydraProtocolError('Hydra HTTP response exceeded its byte limit');
	}
	return responseText;
}

/**
 * `body` is the already-parsed JSON response, when there was one to parse (the
 * malformed-body call site has none). A hydra-node HTTP refusal — 2.4.1's
 * `POST /commit` DepositTooLarge included — carries its reason as `{tag: ...}`,
 * the same shape `postTxError` uses over the websocket. Reusing `postTxErrorTag`
 * here means a caller's `.message` names that reason instead of just the HTTP
 * status: without it every 4xx read as identically "Hydra HTTP request failed
 * with 400 Bad Request", and that generic text is what ends up recorded against
 * a failed top-up.
 */
export function createHttpResponseError(response: Response, body?: unknown): Error {
	const status = [response.status, response.statusText].filter(Boolean).join(' ');
	const statusSuffix = status ? ` with ${status}` : '';
	const reasonTag = postTxErrorTag(body);
	const reasonSuffix = reasonTag !== null ? ` (${reasonTag})` : '';
	return new HydraHttpResponseError(`Hydra HTTP request failed${statusSuffix}${reasonSuffix}`, response.status);
}
