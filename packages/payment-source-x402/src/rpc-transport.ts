import { request as requestHttp, type RequestOptions } from 'node:http';
import { request as requestHttps } from 'node:https';
import { pipeline, type Readable } from 'node:stream';
import { createBrotliDecompress, createUnzip } from 'node:zlib';
import createHttpError from 'http-errors';
import * as ssrfGuard from '@masumi/payment-core/ssrf-guard';
import type { ResolvedAddress } from '@masumi/payment-core/ssrf-guard';

const MAX_RPC_RESPONSE_BYTES = 8 * 1024 * 1024;

async function resolveCheckedAddresses(hostname: string, signal?: AbortSignal): Promise<ResolvedAddress[]> {
	if (ssrfGuard.isPrivateIpLiteral(hostname)) {
		throw createHttpError(400, 'x402 network rpcUrl must not target a private, loopback or link-local address');
	}
	signal?.throwIfAborted();
	let onAbort: () => void = () => undefined;
	let addresses: ResolvedAddress[];
	try {
		addresses = await new Promise<ResolvedAddress[]>((resolve, reject) => {
			onAbort = () =>
				reject(
					signal?.reason instanceof Error ? signal.reason : createHttpError(408, 'x402 network RPC request aborted'),
				);
			signal?.addEventListener('abort', onAbort, { once: true });
			void ssrfGuard.resolveHostnameAddresses(hostname).then(resolve, reject);
		});
	} catch (error) {
		if (signal?.aborted) throw error;
		throw createHttpError(400, 'x402 network rpcUrl hostname is unresolvable');
	} finally {
		signal?.removeEventListener('abort', onAbort);
	}
	if (
		addresses.length === 0 ||
		addresses.some(({ address, family }) => ssrfGuard.isBlockedIpAddress(address, family))
	) {
		throw createHttpError(400, 'x402 network rpcUrl must not resolve to a private, loopback or link-local address');
	}
	return addresses;
}

function decodedBody(response: Readable & { headers: Record<string, string | string[] | undefined> }): Readable {
	const contentEncoding = response.headers['content-encoding'];
	const encoding = typeof contentEncoding === 'string' ? contentEncoding.trim().toLowerCase() : '';
	if (encoding === '' || encoding === 'identity') return response;
	const decoder =
		encoding === 'gzip' || encoding === 'deflate' ? createUnzip() : encoding === 'br' ? createBrotliDecompress() : null;
	if (decoder == null) throw createHttpError(502, 'x402 network RPC response uses unsupported content encoding');
	pipeline(response, decoder, () => undefined);
	return decoder;
}

async function readBoundedBody(body: Readable, signal?: AbortSignal): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let totalBytes = 0;
	for await (const chunk of body as AsyncIterable<Uint8Array>) {
		signal?.throwIfAborted();
		const bytes = Buffer.from(chunk);
		totalBytes += bytes.length;
		if (totalBytes > MAX_RPC_RESPONSE_BYTES) {
			body.destroy();
			throw createHttpError(502, 'x402 network RPC response is too large');
		}
		chunks.push(bytes);
	}
	return Buffer.concat(chunks, totalBytes);
}

/** viem's fetch hook. Resolve and check each request, then pass only checked IPs to the socket. */
export async function fetchPinnedRpc(input: string | URL | Request, init?: RequestInit): Promise<Response> {
	const url = new URL(input instanceof Request ? input.url : input);
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw createHttpError(400, 'x402 network rpcUrl must use http or https');
	}
	const signal = init?.signal ?? undefined;
	const addresses = await resolveCheckedAddresses(url.hostname, signal);
	const pinnedAddress = addresses[0];
	const requestBody = init?.body ?? '';
	if (typeof requestBody !== 'string') {
		throw createHttpError(400, 'x402 network RPC request body must be text');
	}
	const headers = new Headers(init?.headers);
	headers.delete('host');
	headers.set('Accept-Encoding', 'identity');
	headers.set('Content-Length', Buffer.byteLength(requestBody).toString());
	const options: RequestOptions & { autoSelectFamily: boolean } = {
		agent: false,
		autoSelectFamily: true,
		signal,
		method: init?.method ?? 'POST',
		headers: Object.fromEntries(headers),
		// URL keeps Host and TLS SNI; this callback supplies only approved addresses.
		lookup: (_hostname, lookupOptions, callback) => {
			if (lookupOptions.all) callback(null, addresses);
			else callback(null, pinnedAddress.address, pinnedAddress.family);
		},
	};
	const request = url.protocol === 'https:' ? requestHttps : requestHttp;
	return await new Promise<Response>((resolve, reject) => {
		const clientRequest = request(url, options, (response) => {
			void (async () => {
				const status = response.statusCode ?? 0;
				if (status >= 300 && status < 400) throw createHttpError(502, 'x402 network RPC redirects are not allowed');
				if (status < 200 || status > 599) throw createHttpError(502, 'x402 network RPC returned an invalid status');
				const body = status === 204 || status === 205 ? null : await readBoundedBody(decodedBody(response), signal);
				if (body === null) response.destroy();
				const responseHeaders = new Headers();
				for (const [name, value] of Object.entries(response.headers)) {
					if (typeof value === 'string') responseHeaders.set(name, value);
					else if (Array.isArray(value)) for (const entry of value) responseHeaders.append(name, entry);
				}
				responseHeaders.delete('content-encoding');
				responseHeaders.delete('content-length');
				responseHeaders.delete('transfer-encoding');
				resolve(new Response(body, { status, statusText: response.statusMessage, headers: responseHeaders }));
			})().catch((error: unknown) => {
				response.destroy();
				reject(error instanceof Error ? error : createHttpError(502, 'x402 network RPC request failed'));
			});
		});
		clientRequest.once('error', reject);
		clientRequest.once('upgrade', (_response, socket) => {
			socket.destroy();
			reject(createHttpError(502, 'x402 network RPC protocol upgrades are not allowed'));
		});
		clientRequest.end(requestBody);
	});
}
