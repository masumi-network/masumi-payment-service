/**
 * Talking to a counterparty's Exchange Plane.
 *
 * This is the only outbound call whose URL comes from another organisation.
 * HTTPS is the default; HTTP and private/special-use networks each need their
 * own explicit operator consent. DNS is resolved before connecting and the
 * request is pinned to the checked address, so a second lookup cannot rebind a
 * public name to an internal service. Redirects are never followed.
 */

import { lookup } from 'node:dns/promises';
import http, { type RequestOptions } from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import createHttpError from 'http-errors';
import { logger } from '@masumi/payment-core/logger';

const REQUEST_TIMEOUT_MS = 20_000;
const RESOLVE_TIMEOUT_MS = 5_000;
const MAX_PENDING_EXCHANGE_LOOKUPS = 16;
const MAX_ERROR_RESPONSE_BYTES = 4 * 1024;
/**
 * 503 is the only refusal worth retrying in place: the Host answers it before
 * it spends the nonce, when its body readers or in-flight slots are full, which
 * a flood against its Exchange Plane can cause. The waits add up to 7 s, longer
 * than the Host's 5 s body deadline, so a reader held by a slow body has been
 * freed by the last try. A stopped node answers 503 too and stays refused, so
 * the waits stay short.
 */
const BUSY_STATUS = 503;
const BUSY_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

export type RedemptionBody = {
	nonce: string;
	redeemer: {
		walletAddress: string;
		hydraVerificationKey: string;
		cardanoVerificationKey: string;
		advertise: string;
		exchangeUrl: string;
	};
	signature: { signature: string; key: string };
};

export type ExchangeTransportOptions = {
	allowInsecureHttp: boolean;
	allowPrivateNetwork: boolean;
};

export type ResolvedExchangeTarget = {
	address: string;
	family: 4 | 6;
	isPrivate: boolean;
};

type ExchangeResolver = (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;

type ExchangeRequestResult = { status: number; detail: string };

export type ExchangeClientDeps = {
	resolve?: ExchangeResolver;
	send?: (url: URL, target: ResolvedExchangeTarget, body: Buffer) => Promise<ExchangeRequestResult>;
	sleep?: (ms: number) => Promise<void>;
	resolveDeadlineMs?: number;
	requestDeadlineMs?: number;
};

const blockedIpv4 = new BlockList();
for (const [network, prefix] of [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.0.2.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['198.51.100.0', 24],
	['203.0.113.0', 24],
	['224.0.0.0', 4],
	['240.0.0.0', 4],
] as const) {
	blockedIpv4.addSubnet(network, prefix, 'ipv4');
}

const blockedIpv6 = new BlockList();
for (const [network, prefix] of [
	['::', 128],
	['::1', 128],
	['::ffff:0:0', 96],
	['64:ff9b::', 96],
	['100::', 64],
	// Teredo and 6to4 both embed an IPv4 address, so an unfiltered one is a
	// route back to a blocked range by another name.
	['2001::', 32],
	['2001:db8::', 32],
	['2002::', 16],
	['fc00::', 7],
	['fe80::', 10],
	['ff00::', 8],
] as const) {
	blockedIpv6.addSubnet(network, prefix, 'ipv6');
}

function withoutIpv6Brackets(hostname: string): string {
	return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

export function isPrivateOrSpecialAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) {
		return blockedIpv4.check(address, 'ipv4');
	}
	if (family === 6) {
		return blockedIpv6.check(address, 'ipv6');
	}
	throw createHttpError(400, 'the counterparty exchange hostname resolved to an invalid IP address');
}

export function assertExchangeTransportAllowed(rawUrl: string, transport: ExchangeTransportOptions): URL {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw createHttpError(400, 'the counterparty exchange URL is not a URL');
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw createHttpError(400, `the counterparty exchange URL must be http or https, got ${url.protocol}`);
	}
	if (url.username.length > 0 || url.password.length > 0) {
		throw createHttpError(400, 'the counterparty exchange URL must not contain credentials');
	}
	if (url.hash.length > 0 || url.search.length > 0) {
		throw createHttpError(400, 'the counterparty exchange URL must not contain a query string or fragment');
	}
	if (url.protocol === 'http:' && !transport.allowInsecureHttp) {
		throw createHttpError(
			400,
			'the counterparty exchange URL uses HTTP; explicitly confirm allowInsecureExchangeHttp to continue',
		);
	}
	return url;
}

/** A timed-out getaddrinfo cannot be cancelled, so bound and share unfinished jobs. */
export function createBoundedExchangeResolver(
	lookupHost: ExchangeResolver = async (hostname) => await lookup(hostname, { all: true, verbatim: true }),
	maxPending = MAX_PENDING_EXCHANGE_LOOKUPS,
): ExchangeResolver {
	const pending = new Map<string, Promise<ReadonlyArray<{ address: string; family: number }>>>();
	return async (hostname) => {
		const key = hostname.toLowerCase();
		let result = pending.get(key);
		if (result === undefined) {
			if (pending.size >= maxPending) throw new Error('counterparty exchange resolver is busy');
			const started = Promise.resolve().then(async () => await lookupHost(hostname));
			pending.set(key, started);
			void started.then(
				() => pending.delete(key),
				() => pending.delete(key),
			);
			result = started;
		}
		return await result;
	};
}

const defaultResolver = createBoundedExchangeResolver();

async function resolveBeforeDeadline(
	resolve: ExchangeResolver,
	hostname: string,
	deadlineMs: number,
): Promise<ReadonlyArray<{ address: string; family: number }>> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			resolve(hostname),
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error('counterparty exchange lookup timed out')), deadlineMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** Resolve every answer, reject special-use results, then select a pinned IP. */
export async function resolveExchangeTarget(
	rawUrl: string,
	transport: ExchangeTransportOptions,
	resolve: ExchangeResolver = defaultResolver,
	resolveDeadlineMs = RESOLVE_TIMEOUT_MS,
): Promise<{ url: URL; target: ResolvedExchangeTarget }> {
	const url = assertExchangeTransportAllowed(rawUrl, transport);
	const hostname = withoutIpv6Brackets(url.hostname);
	const literalFamily = isIP(hostname);
	let answers: ReadonlyArray<{ address: string; family: number }>;
	try {
		answers =
			literalFamily === 0
				? await resolveBeforeDeadline(resolve, hostname, resolveDeadlineMs)
				: [{ address: hostname, family: literalFamily }];
	} catch (error) {
		throw createHttpError(502, `the counterparty exchange hostname could not be resolved: ${(error as Error).message}`);
	}

	const targets = answers
		.filter((answer): answer is { address: string; family: 4 | 6 } => answer.family === 4 || answer.family === 6)
		.map((answer) => ({
			address: answer.address,
			family: answer.family,
			isPrivate: isPrivateOrSpecialAddress(answer.address),
		}));
	if (targets.length === 0) {
		throw createHttpError(502, 'the counterparty exchange hostname resolved to no usable IP addresses');
	}

	// Reject the complete DNS set if any answer is private. Selecting only a
	// public member of a mixed set would make later resolver ordering a bypass.
	if (targets.some((target) => target.isPrivate) && !transport.allowPrivateNetwork) {
		throw createHttpError(
			400,
			'the counterparty exchange resolves to a private or special-use address; explicitly confirm ' +
				'allowPrivateExchangeNetwork to continue',
		);
	}
	return { url, target: targets[0] };
}

/** Resolve without connecting, used to show the operator the private-network warning. */
export async function inspectExchangeNetwork(rawUrl: string): Promise<{ usesPrivateNetwork: boolean }> {
	const { target } = await resolveExchangeTarget(rawUrl, {
		allowInsecureHttp: true,
		allowPrivateNetwork: true,
	});
	return { usesPrivateNetwork: target.isPrivate };
}

function sendPinnedRequest(
	url: URL,
	target: ResolvedExchangeTarget,
	body: Buffer,
	deadlineMs = REQUEST_TIMEOUT_MS,
): Promise<ExchangeRequestResult> {
	return new Promise((resolve, reject) => {
		const complete = (result: ExchangeRequestResult): void => {
			clearTimeout(deadline);
			resolve(result);
		};
		const fail = (error: Error): void => {
			clearTimeout(deadline);
			reject(error);
		};
		const originalHostname = withoutIpv6Brackets(url.hostname);
		const options: RequestOptions = {
			protocol: url.protocol,
			hostname: target.address,
			family: target.family,
			port: url.port || undefined,
			method: 'POST',
			path: `${url.pathname}${url.search}`,
			headers: {
				Host: url.host,
				'Content-Type': 'application/json',
				'Content-Length': String(body.length),
				Connection: 'close',
			},
			// HTTPS connects to the checked IP but authenticates the signed name.
			...(url.protocol === 'https:' && isIP(originalHostname) === 0 ? { servername: originalHostname } : {}),
		};
		const request = (url.protocol === 'https:' ? https.request : http.request)(options, (response) => {
			const status = response.statusCode ?? 502;
			if (status >= 200 && status < 300) {
				// Acceptance needs only the status. Close the unused body so an active
				// peer cannot retain this socket by streaming past the inactivity timeout.
				response.destroy();
				complete({ status, detail: '' });
				return;
			}

			let size = 0;
			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer) => {
				size += chunk.length;
				if (size > MAX_ERROR_RESPONSE_BYTES) {
					response.destroy(new Error('counterparty response exceeded the size limit'));
					return;
				}
				chunks.push(chunk);
			});
			response.on('end', () => complete({ status, detail: Buffer.concat(chunks).toString('utf8') }));
			response.on('error', fail);
		});
		request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error('request timed out')));
		const deadline = setTimeout(
			() => request.destroy(new Error('counterparty exchange request deadline exceeded')),
			deadlineMs,
		);
		request.on('error', fail);
		request.end(body);
	});
}

/**
 * What a send attempt tells the caller about whether the nonce may be spent.
 *
 * - `accepted`: the Host took it (2xx), or recognised it as the same redemption.
 * - `answered`: a status other than 2xx. `fromHost` says the body is a Host
 *   refusal that carries one of the Host's codes. Every Host 503 carries one and
 *   comes before the nonce is spent. Without a code the status may come from a
 *   gateway in front of the Host, which can answer after a redemption landed.
 * - `not-sent`: nothing left this machine, or no connection was ever made.
 * - `unknown`: the request may have reached the Host and the answer was lost.
 */
export type ExchangeAttempt =
	| { kind: 'accepted' }
	| { kind: 'answered'; status: number; code: string | null; fromHost: boolean; detail: string }
	| { kind: 'not-sent'; error: createHttpError.HttpError }
	| { kind: 'unknown'; reason: string; host: string };

/**
 * Errors raised before any request bytes could have reached the Host: no
 * connection, or a TLS handshake that failed verification. A reset, a timeout
 * or a broken pipe are deliberately absent, because those can follow a
 * request the Host already processed.
 */
const NEVER_SENT_ERROR_CODES = new Set([
	'ECONNREFUSED',
	'ENOTFOUND',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'EAI_AGAIN',
	'CERT_HAS_EXPIRED',
	'CERT_NOT_YET_VALID',
	'DEPTH_ZERO_SELF_SIGNED_CERT',
	'SELF_SIGNED_CERT_IN_CHAIN',
	'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
	'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
	'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * The codes the Host puts on a refusal: `redeemed-by-other` on a 409 and
 * `host-unavailable` on every 503 (`HOST_UNAVAILABLE_CODE` in the Host's
 * exchange server). Kept as a copy because `src/` does not depend on the Host.
 */
const HOST_REFUSAL_CODES: ReadonlySet<string> = new Set(['redeemed-by-other', 'host-unavailable']);

/**
 * Read a refusal body. Every Host refusal is `{ error }`, and the ones a
 * redeemer acts on add a `code`. A gateway's HTML, plain text or its own
 * `{ error }` JSON carries none of the Host's codes, so it reads as not the Host's.
 */
export function readRefusal(detail: string): { code: string | null; fromHost: boolean } {
	try {
		const parsed: unknown = JSON.parse(detail);
		if (typeof parsed === 'object' && parsed !== null) {
			const code = 'code' in parsed && typeof parsed.code === 'string' ? parsed.code : null;
			return {
				code,
				fromHost:
					'error' in parsed && typeof parsed.error === 'string' && code !== null && HOST_REFUSAL_CODES.has(code),
			};
		}
	} catch {
		// A gateway's HTML or plain text.
	}
	return { code: null, fromHost: false };
}

async function attempt(
	rawUrl: string,
	pathname: string,
	body: unknown,
	what: string,
	transport: ExchangeTransportOptions,
	deps: ExchangeClientDeps = {},
): Promise<ExchangeAttempt> {
	let url: URL;
	let target: ResolvedExchangeTarget;
	try {
		({ url, target } = await resolveExchangeTarget(rawUrl, transport, deps.resolve, deps.resolveDeadlineMs));
	} catch (error) {
		if (createHttpError.isHttpError(error)) return { kind: 'not-sent', error };
		throw error;
	}
	url.pathname = `${url.pathname.replace(/\/+$/, '')}${pathname}`;
	if (url.protocol === 'http:') {
		logger.warn(`hydra: sending ${what} over explicitly allowed HTTP to ${url.host}`);
	}
	if (target.isPrivate) {
		logger.warn(`hydra: sending ${what} to explicitly allowed private address for ${url.host}`);
	}

	let earlierMayHaveLanded = false;
	try {
		const send =
			deps.send ??
			((url: URL, target: ResolvedExchangeTarget, body: Buffer) =>
				sendPinnedRequest(url, target, body, deps.requestDeadlineMs));
		const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
		const payload = Buffer.from(JSON.stringify(body));
		let result = await send(url, target, payload);
		// Only a status the Host answered counts: a transport failure may have
		// landed and spent the nonce, so it is never retried.
		for (const delayMs of BUSY_RETRY_DELAYS_MS) {
			if (result.status !== BUSY_STATUS) break;
			// A 503 that is not the Host's own may follow a redemption it stored, and
			// then whatever the resend hears says nothing about the first send.
			if (!readRefusal(result.detail).fromHost) earlierMayHaveLanded = true;
			await sleep(delayMs);
			result = await send(url, target, payload);
		}
		if (result.status >= 200 && result.status < 300) return { kind: 'accepted' };
		if (earlierMayHaveLanded) {
			return { kind: 'unknown', reason: `a gateway answered ${BUSY_STATUS} before the Host did`, host: url.host };
		}
		return { kind: 'answered', status: result.status, ...readRefusal(result.detail), detail: result.detail };
	} catch (error) {
		const reason = (error as Error).message;
		logger.warn(`hydra: ${what} to ${url.host} failed: ${reason}`);
		const code = (error as NodeJS.ErrnoException).code;
		if (!earlierMayHaveLanded && code !== undefined && NEVER_SENT_ERROR_CODES.has(code)) {
			return {
				kind: 'not-sent',
				error: createHttpError(502, `could not reach the counterparty exchange at ${url.host}: ${reason}`),
			};
		}
		return { kind: 'unknown', reason, host: url.host };
	}
}

/** The error that describes an attempt which did not work, in the words the operator has always seen. */
export function attemptFailure(
	outcome: Exclude<ExchangeAttempt, { kind: 'accepted' }>,
	what = 'redemption',
): createHttpError.HttpError {
	if (outcome.kind === 'not-sent') return outcome.error;
	if (outcome.kind === 'unknown') {
		return createHttpError(502, `could not reach the counterparty exchange at ${outcome.host}: ${outcome.reason}`);
	}
	// 401 is the Host refusing our signature before it spent the nonce, so
	// the invite is still open and the operator can retry. So is 503, which
	// a paused Host also answers.
	const detail = [401, 409, 410, 503].includes(outcome.status) ? outcome.detail.slice(0, 200) : '';
	return createHttpError(502, `the counterparty refused the ${what} (${outcome.status})${detail ? `: ${detail}` : ''}`);
}

/**
 * Send our material to the issuer, which is what lets their reserved node boot,
 * and say what happened rather than throwing: the caller decides what an
 * answered refusal, a lost answer and an unsent request each mean for its record.
 */
export async function attemptRedemption(
	exchangeUrl: string,
	body: RedemptionBody,
	transport: ExchangeTransportOptions,
	deps: ExchangeClientDeps = {},
): Promise<ExchangeAttempt> {
	return await attempt(exchangeUrl, '/redeem', body, 'redemption', transport, deps);
}
