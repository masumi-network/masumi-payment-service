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
const MAX_ERROR_RESPONSE_BYTES = 4 * 1024;

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
	['2001:db8::', 32],
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

const defaultResolver: ExchangeResolver = async (hostname) => await lookup(hostname, { all: true, verbatim: true });

/** Resolve every answer, reject special-use results, then select a pinned IP. */
export async function resolveExchangeTarget(
	rawUrl: string,
	transport: ExchangeTransportOptions,
	resolve: ExchangeResolver = defaultResolver,
): Promise<{ url: URL; target: ResolvedExchangeTarget }> {
	const url = assertExchangeTransportAllowed(rawUrl, transport);
	const hostname = withoutIpv6Brackets(url.hostname);
	const literalFamily = isIP(hostname);
	let answers: ReadonlyArray<{ address: string; family: number }>;
	try {
		answers = literalFamily === 0 ? await resolve(hostname) : [{ address: hostname, family: literalFamily }];
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

function sendPinnedRequest(url: URL, target: ResolvedExchangeTarget, body: Buffer): Promise<ExchangeRequestResult> {
	return new Promise((resolve, reject) => {
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
				response.resume();
				resolve({ status, detail: '' });
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
			response.on('end', () => resolve({ status, detail: Buffer.concat(chunks).toString('utf8') }));
			response.on('error', reject);
		});
		request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error('request timed out')));
		request.on('error', reject);
		request.end(body);
	});
}

async function post(
	rawUrl: string,
	pathname: string,
	body: unknown,
	what: string,
	transport: ExchangeTransportOptions,
	deps: ExchangeClientDeps = {},
): Promise<void> {
	const { url, target } = await resolveExchangeTarget(rawUrl, transport, deps.resolve);
	url.pathname = `${url.pathname.replace(/\/+$/, '')}${pathname}`;
	if (url.protocol === 'http:') {
		logger.warn(`hydra: sending ${what} over explicitly allowed HTTP to ${url.host}`);
	}
	if (target.isPrivate) {
		logger.warn(`hydra: sending ${what} to explicitly allowed private address for ${url.host}`);
	}

	try {
		const result = await (deps.send ?? sendPinnedRequest)(url, target, Buffer.from(JSON.stringify(body)));
		if (result.status < 200 || result.status >= 300) {
			const detail = result.status === 409 || result.status === 410 ? result.detail.slice(0, 200) : '';
			throw createHttpError(
				502,
				`the counterparty refused the ${what} (${result.status})${detail ? `: ${detail}` : ''}`,
			);
		}
	} catch (error) {
		if (createHttpError.isHttpError(error)) {
			throw error;
		}
		const reason = (error as Error).message;
		logger.warn(`hydra: ${what} to ${url.host} failed: ${reason}`);
		throw createHttpError(502, `could not reach the counterparty exchange at ${url.host}: ${reason}`);
	}
}

/** Send our material to the issuer, which is what lets their reserved node boot. */
export async function postRedemption(
	exchangeUrl: string,
	body: RedemptionBody,
	transport: ExchangeTransportOptions,
	deps: ExchangeClientDeps = {},
): Promise<void> {
	await post(exchangeUrl, '/redeem', body, 'redemption', transport, deps);
}
