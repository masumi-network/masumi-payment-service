import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import {
	isWebhookDestinationPolicyError,
	resolveWebhookDestinationAllowed,
	type ResolvedAddress,
} from '@/utils/security/webhook-destination-policy';

/**
 * One outbound HTTP request to an untrusted URL, with the same guarantees as the A2A agent-card
 * fetch: the destination is resolved once and checked against the SSRF policy, the connection is
 * pinned to the checked address (TLS and SNI keep the hostname), redirects are never followed,
 * the body is size-capped, and one deadline covers DNS, connect and body.
 *
 * Failures are returned, not thrown: callers such as the agent validator report them as findings.
 */

export type PinnedRequestOptions = {
	method: 'GET' | 'POST';
	/** JSON text, sent with Content-Type: application/json. POST only. */
	body?: string;
	timeoutMs: number;
	maxBytes: number;
};

/**
 * Why the destination was rejected before any connection: it resolves to a private or local address,
 * its hostname does not resolve at all, or something else about the URL (e.g. embedded credentials).
 */
export type BlockCause = 'blocked_address' | 'unresolvable' | 'other';

// Matches the messages of webhook-destination-policy.ts and ssrf-guard.ts, which have no error codes.
const classifyRejection = (reason: string): BlockCause => {
	if (reason.includes('blocked address')) return 'blocked_address';
	if (/could not be resolved|resolved to no addresses|unsupported address families/.test(reason)) return 'unresolvable';
	return 'other';
};

export type PinnedRequestResult =
	| { kind: 'response'; status: number; location: string | null; body: string; durationMs: number }
	| { kind: 'blocked'; cause: BlockCause; reason: string }
	| { kind: 'error'; error: string; durationMs: number };

type RawResponse = { status: number; location: string | null; body: string };

// Only these mean the request never reached the agent, so sending it to the next address is safe even
// for a POST. Anything else (a reset, a stream error, a bad response) may have been acted on already.
const CONNECTION_FAILURE_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EADDRNOTAVAIL']);

const isConnectionFailure = (error: unknown): boolean =>
	typeof error === 'object' &&
	error !== null &&
	'code' in error &&
	typeof error.code === 'string' &&
	CONNECTION_FAILURE_CODES.has(error.code);

const USER_AGENT = 'masumi-payment-service/agent-validation';

export async function pinnedRequest(rawUrl: string, options: PinnedRequestOptions): Promise<PinnedRequestResult> {
	const startedAt = Date.now();
	const elapsed = () => Date.now() - startedAt;
	const controller = new AbortController();
	let rejectDeadline!: (error: Error) => void;
	const deadline = new Promise<never>((_resolve, reject) => {
		rejectDeadline = reject;
	});
	const timeout = setTimeout(() => {
		rejectDeadline(new Error(`timed out after ${options.timeoutMs} ms`));
		controller.abort();
	}, options.timeoutMs);
	timeout.unref();

	try {
		let destination: { url: URL; addresses: ResolvedAddress[] };
		try {
			destination = await Promise.race([resolveWebhookDestinationAllowed(rawUrl), deadline]);
		} catch (error) {
			if (isWebhookDestinationPolicyError(error)) {
				return { kind: 'blocked', cause: classifyRejection(error.reason), reason: error.reason };
			}
			throw error;
		}
		const response = await Promise.race([
			requestAddresses(destination.url, destination.addresses, options, controller.signal),
			deadline,
		]);
		return { kind: 'response', ...response, durationMs: elapsed() };
	} catch (error) {
		const message = controller.signal.aborted
			? `timed out after ${options.timeoutMs} ms`
			: error instanceof Error
				? error.message
				: String(error);
		return { kind: 'error', error: message, durationMs: elapsed() };
	} finally {
		clearTimeout(timeout);
	}
}

async function requestAddresses(
	url: URL,
	addresses: ResolvedAddress[],
	options: PinnedRequestOptions,
	signal: AbortSignal,
): Promise<RawResponse> {
	for (const [index, address] of addresses.entries()) {
		try {
			return await requestAtAddress(url, address, options, signal);
		} catch (error) {
			if (signal.aborted || !isConnectionFailure(error) || index === addresses.length - 1) throw error;
		}
	}
	throw new Error('hostname resolved to no addresses');
}

function requestAtAddress(
	url: URL,
	address: ResolvedAddress,
	options: PinnedRequestOptions,
	signal: AbortSignal,
): Promise<RawResponse> {
	return new Promise((resolve, reject) => {
		const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
		const payload = options.method === 'POST' ? (options.body ?? '') : undefined;
		const req = send(
			url,
			{
				method: options.method,
				agent: false,
				signal,
				family: address.family,
				autoSelectFamily: false,
				// Resolve once. Keep the original URL host for TLS certificate checks and SNI.
				lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
				headers: {
					Accept: 'application/json',
					'Accept-Encoding': 'identity',
					'User-Agent': USER_AGENT,
					...(payload === undefined
						? {}
						: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
				},
			} as RequestOptions & { autoSelectFamily: boolean },
			(response) => {
				void readResponse(response, url, options.maxBytes).then(resolve, (error: unknown) => {
					reject(error instanceof Error ? error : new Error(String(error)));
					response.destroy();
					req.destroy();
				});
			},
		);
		req.on('error', reject);
		req.end(payload);
	});
}

async function readResponse(response: IncomingMessage, requestUrl: URL, maxBytes: number): Promise<RawResponse> {
	const status = response.statusCode ?? 0;
	const rawLocation = response.headers.location;
	if (status >= 300 && status < 400) {
		// Redirects are reported, never followed, so the body is not needed.
		response.destroy();
		return { status, location: rawLocation ? new URL(rawLocation, requestUrl).toString() : null, body: '' };
	}
	const tooLarge = new Error(`response is larger than ${maxBytes} bytes`);
	const declared = response.headers['content-length'];
	if (declared != null && Number(declared) > maxBytes) throw tooLarge;

	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of response) {
		const raw: unknown = chunk;
		const buffer = raw instanceof Uint8Array ? Buffer.from(raw) : Buffer.from(String(raw));
		bytes += buffer.length;
		if (bytes > maxBytes) throw tooLarge;
		chunks.push(buffer);
	}
	return { status, location: null, body: Buffer.concat(chunks, bytes).toString('utf8') };
}
