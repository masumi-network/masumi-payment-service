import createHttpError from 'http-errors';
import { request as requestHttp, type RequestOptions } from 'node:http';
import { request as requestHttps } from 'node:https';
import { Readable, pipeline } from 'node:stream';
import { createBrotliDecompress, createUnzip } from 'node:zlib';
import { resolveAllowedHostDestination } from './destination';

const PRE_DISPATCH_ERROR_HEADER = 'x-hydra-host-proxy-error';

export type HydraHostFetchOptions = {
	method?: string;
	redirect?: 'error' | 'manual';
	headers: Record<string, string>;
	body?: string;
	signal: AbortSignal;
};

/** Stop waiting for DNS when the same deadline that covers the request expires. */
async function resolveWithSignal(url: string, signal: AbortSignal) {
	signal.throwIfAborted();
	let abort: () => void = () => undefined;
	try {
		return await new Promise<Awaited<ReturnType<typeof resolveAllowedHostDestination>>>((resolve, reject) => {
			abort = () =>
				reject(signal.reason instanceof Error ? signal.reason : createHttpError(408, 'Hydra Host request aborted'));
			signal.addEventListener('abort', abort, { once: true });
			void resolveAllowedHostDestination(url).then(resolve, reject);
		});
	} finally {
		signal.removeEventListener('abort', abort);
	}
}

/**
 * Resolve and check each call, including calls to Hosts stored before the guard.
 * The socket receives only those checked answers. Keep the URL's hostname for
 * the Host header, TLS SNI and certificate checks. Node tries approved address
 * alternatives before sending this single request; mutations are never replayed.
 */
export async function fetchHydraHost(url: string, init: HydraHostFetchOptions): Promise<Response> {
	const addresses = await resolveWithSignal(url, init.signal);
	const parsed = new URL(url);
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw createHttpError(400, 'Hydra Host URL must use HTTP or HTTPS');
	}
	return await new Promise<Response>((resolve, reject) => {
		const options: RequestOptions & { autoSelectFamily: boolean } = {
			agent: false,
			autoSelectFamily: true,
			signal: init.signal,
			method: init.method ?? 'GET',
			headers: { ...init.headers, 'Accept-Encoding': 'identity' },
			lookup: (_hostname, lookupOptions, callback) => {
				if (lookupOptions.all) callback(null, addresses);
				else callback(null, addresses[0].address, addresses[0].family);
			},
		};
		const request = (parsed.protocol === 'https:' ? requestHttps : requestHttp)(parsed, options, (response) => {
			try {
				const status = response.statusCode ?? 0;
				if (status >= 300 && status < 400 && init.redirect !== 'manual') {
					throw createHttpError(502, 'Hydra Host redirects are not allowed');
				}
				// Carry only the Host's non-dispatch marker. The proxy strips this
				// header from node replies, so it cannot be forged by the node.
				const marker = status === 502 ? response.headers[PRE_DISPATCH_ERROR_HEADER] : undefined;
				const responseInit = {
					status,
					statusText: response.statusMessage,
					...(typeof marker === 'string' ? { headers: { [PRE_DISPATCH_ERROR_HEADER]: marker } } : {}),
				};
				if (status === 204 || status === 205 || status === 304) {
					response.destroy();
					resolve(new Response(null, responseInit));
					return;
				}
				let body: Readable = response;
				const encoding = response.headers['content-encoding']?.trim().toLowerCase();
				if (encoding && encoding !== 'identity') {
					const decoder =
						encoding === 'gzip' || encoding === 'deflate'
							? createUnzip()
							: encoding === 'br'
								? createBrotliDecompress()
								: null;
					if (decoder === null) throw createHttpError(502, 'Hydra Host response uses an unsupported content encoding');
					body = decoder;
					// Pipeline forwards reset/decode errors and cancels the source when
					// the bounded reader destroys the decoded stream.
					pipeline(response, decoder, () => undefined);
				}
				const stream = Readable.toWeb(body, {
					strategy: { highWaterMark: body.readableHighWaterMark, size: (chunk: Uint8Array) => chunk.byteLength },
				});
				resolve(new Response(stream as ReadableStream<Uint8Array>, responseInit));
			} catch (error) {
				reject(error instanceof Error ? error : createHttpError(502, 'Hydra Host transport failed'));
				response.destroy();
			}
		});
		request.once('error', reject);
		request.once('upgrade', (_response, socket) => {
			socket.destroy();
			reject(createHttpError(502, 'Hydra Host protocol upgrades are not allowed'));
		});
		request.end(init.body);
	});
}
