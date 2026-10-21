/**
 * The Exchange Plane: the one Host surface a counterparty may reach.
 *
 * A separate listener rather than a path on the control plane, because the two
 * have opposite security models and mixing them means one routing mistake
 * exposes fleet management. Nothing here can provision, delete, reconfigure or
 * proxy a node; its entire vocabulary is "redeem an invite I issued".
 *
 * It is unauthenticated by design — the invite is the credential and its
 * authority is a signature. But it is not an open door:
 *
 *  - redemption requires a nonce this Host issued, unspent and unexpired;
 *  - the redeemer's signature must verify against the wallet it names before
 *    the nonce is spent, so a forged or malformed body cannot burn an invite;
 *  - requests are limited per source and in total; past the total, only a
 *    redemption of an open invite is still served;
 *  - bodies are capped and connection timeouts are short.
 *
 * The payment service verifies the same signature again when it adopts the
 * redemption. The Host's check protects the nonce; the service's check decides
 * whether a head is recorded.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { constantTimeEquals } from './auth.js';
import type { ExchangeStore } from '../registry/exchange-store.js';
import {
	isExchangeMaterial,
	isExchangeSignature,
	type ExchangeMaterial,
	type ExchangeSignature,
} from '../registry/exchange-types.js';
import type { PeerTargetCheck } from '../peer-target-policy.js';
import type { SupervisorLogger } from '../supervisor/supervisor.js';

/** Smaller than the control plane's: an invite is a few hundred bytes. */
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_MAX_IN_FLIGHT = 16;
const DEFAULT_MAX_BODY_READERS = 32;
const DEFAULT_MAX_BODY_READERS_PER_SOURCE = 4;
const DEFAULT_BODY_TIMEOUT_MS = 5_000;
/**
 * Body deadline for a request past the shared budget. A redemption is a few
 * hundred bytes and arrives at once, so this costs a real redeemer nothing,
 * but a slow body past the budget frees its reader five times sooner. Holding
 * every reader then takes several times more sources.
 */
const OVER_BUDGET_BODY_TIMEOUT_MS = 1_000;
const DEFAULT_REQUESTS_PER_MINUTE = 120;

/**
 * One budget for every source together, spent before any body is read. Once it
 * is spent, a request is still read but served only if it redeems an open
 * invite, so junk traffic cannot lock the real counterparty out.
 *
 * The per-source limit stops one caller from starving another, but a flood from
 * many addresses passes it: each address stays under its own limit. This cap
 * bounds what the whole plane admits per minute, whatever the address count.
 *
 * Sized from what legitimate traffic can be. A redemption is one POST, retried
 * at most three times and only on 503 (`postRedemption` in the payment
 * service), and every invite reserves one node slot, 32 by default
 * (`HYDRA_HOST_PEER_PORT_COUNT`). So even every outstanding invite redeemed in
 * the same minute is 128 requests at most.
 * Twice the per-source limit leaves that peak a wide margin, and one source
 * at its own limit still leaves half the budget for everyone else.
 */
const DEFAULT_TOTAL_REQUESTS_PER_MINUTE = 2 * DEFAULT_REQUESTS_PER_MINUTE;

/**
 * How many distinct sources the per-source counter tracks within one window.
 *
 * The counter exists so one abusive caller cannot spend the whole minute's
 * budget, but keying on the source address means the caller chooses the key.
 * This plane is unauthenticated and reachable from anywhere, and an attacker
 * holding an IPv6 /64 can present a fresh address per connection, so an
 * uncapped map grows with the flood rather than bounding it.
 *
 * Past the cap, further sources share one bucket. A flood stays limited, and a
 * genuine counterparty arriving during one is throttled rather than refused:
 * redemption is a single POST, and the shared bucket still allows the same
 * per-minute budget.
 */
const MAX_TRACKED_SOURCES = 10_000;

/**
 * How many failed redemptions a source is told the reason for.
 *
 * `no such invite`, `already redeemed` and `expired` are three different
 * answers, and the difference tells a caller whether a nonce they guessed
 * exists. Nonces are `cuid2`, so guessing one is hopeless, but the distinction
 * costs nothing to remove for anyone who is not guessing: a real counterparty
 * redeems once, and knowing WHY it failed is the difference between them
 * retrying and them calling the issuer. So the reason is disclosed for the
 * first few failures and withheld after that, which leaves the legitimate case
 * untouched and gives an enumerator a handful of answers per source rather than
 * a working oracle.
 *
 * It composes with the source cap above: past that cap every further source
 * shares one bucket, so rotating addresses converges on a shared budget instead
 * of resetting it.
 */
const MAX_DISCLOSED_REDEEM_FAILURES = 3;
/** A maintenance pause lasts minutes, so a redeemer has no reason to retry sooner. */
const STOPPED_NODE_RETRY_AFTER_SECONDS = 60;

/** Not a possible `remoteAddress`, so it cannot collide with a real source. */
export const OVERFLOW_SOURCE = '\u0000overflow';

/**
 * Which counter this request spends from.
 *
 * Exported so the cap is testable without a second source address: proving it
 * over the live server would need extra loopback IPs, which is exactly the kind
 * of environment assumption that makes a test fail somewhere else.
 */
export function rateLimitKey(remote: string, tracked: ReadonlySet<string> | Map<string, number>, cap: number): string {
	return tracked.has(remote) || tracked.size < cap ? remote : OVERFLOW_SOURCE;
}

/**
 * The address a limit is counted against: an IPv6 source as its /64.
 *
 * One IPv6 subscriber usually holds a whole /64 and can use a fresh address per
 * request, so keying on the full address gives them a fresh per-source budget
 * each time. IPv4, and IPv4 mapped into IPv6, stay keyed on the full address.
 */
export function rateLimitSource(address: string): string {
	const unzoned = (address.split('%')[0] ?? address).toLowerCase();
	if (isIP(unzoned) !== 6) {
		return address;
	}
	const [head = '', tail = ''] = unzoned.split('::');
	const headGroups = toGroups(head);
	const tailGroups = toGroups(tail);
	const groups = [...headGroups, ...Array<number>(8 - headGroups.length - tailGroups.length).fill(0), ...tailGroups];
	// ::ffff:a.b.c.d in any spelling, including the all-hex and uncompressed ones.
	if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
		const [high = 0, low = 0] = groups.slice(6);
		return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
	}
	return `${groups
		.slice(0, 4)
		.map((group) => group.toString(16))
		.join(':')}::/64`;
}

/** One side of `::` as 16-bit groups; a dotted IPv4 tail fills two. */
function toGroups(part: string): number[] {
	if (part === '') {
		return [];
	}
	return part.split(':').flatMap((group) => {
		if (!group.includes('.')) {
			return [parseInt(group, 16)];
		}
		const [a = 0, b = 0, c = 0, d = 0] = group.split('.').map(Number);
		return [(a << 8) | b, (c << 8) | d];
	});
}

export function exchangeRequestSource(
	remote: string | undefined,
	forwarded: string | string[] | undefined,
	trustProxy: boolean,
): string {
	const socketAddress = remote ?? 'unknown';
	if (!trustProxy || forwarded === undefined) {
		return socketAddress;
	}
	const parts = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded).split(',');
	const candidate = parts[parts.length - 1]?.trim();
	return candidate !== undefined && isIP(candidate) !== 0 ? candidate : socketAddress;
}

export type ExchangeDeps = {
	store: ExchangeStore;
	logger: SupervisorLogger;
	/**
	 * Configure and start the node reserved for this invite.
	 *
	 * Separated from the transport so the plane can be tested without a
	 * supervisor, and so a start failure is recorded rather than thrown at a
	 * counterparty who can do nothing about it.
	 */
	onRedeemed: (nonce: string, hostNodeId: string) => Promise<void>;
	/**
	 * Whether the signature is the named wallet's over this redemption.
	 *
	 * Checked before the nonce is spent, because spending is terminal. Injected
	 * so transport tests need not sign every body.
	 */
	verifyRedemption: (nonce: string, redeemer: ExchangeMaterial, signature: ExchangeSignature) => Promise<boolean>;
	/**
	 * Why the redeemer's peer address may not be dialled, or null.
	 *
	 * Checked before the nonce is spent, like the signature, so a refused
	 * address leaves the invite open instead of reserving a node that can never
	 * be configured.
	 */
	checkPeerTarget: PeerTargetCheck;
	/**
	 * Whether the operator stopped the node this invite reserved, as a pause
	 * for maintenance does.
	 *
	 * Checked before the nonce is spent. A redemption now would configure a node
	 * the operator expects to stay down, so it is refused as busy and the invite
	 * stays open for a retry after the node is started again.
	 */
	isNodeStopped: (hostNodeId: string) => Promise<boolean>;
	/** Read X-Forwarded-For only when a trusted HTTP proxy is the sole caller. */
	trustProxy?: boolean;
	/** Test/deployment tuning. Defaults protect a small single-host process. */
	limits?: {
		maxInFlight?: number;
		requestsPerMinute?: number;
		totalRequestsPerMinute?: number;
		maxTrackedSources?: number;
		maxBodyReaders?: number;
		maxBodyReadersPerSource?: number;
		bodyTimeoutMs?: number;
	};
};

function send(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
	response.end(JSON.stringify(body ?? null));
}

async function readBody(request: IncomingMessage, timeoutMs: number): Promise<unknown> {
	const timeout = setTimeout(() => request.destroy(new Error('request body timed out')), timeoutMs);
	try {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of request) {
			const buffer = chunk as Buffer;
			size += buffer.length;
			if (size > MAX_BODY_BYTES) {
				throw new Error('request body is too large');
			}
			chunks.push(buffer);
		}
		if (size === 0) {
			return null;
		}
		try {
			return JSON.parse(Buffer.concat(chunks).toString('utf8'));
		} catch {
			throw new Error('request body is not valid JSON');
		}
	} finally {
		clearTimeout(timeout);
	}
}

const NONCE_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

type RedeemBody = { nonce: string; redeemer: unknown; signature: unknown };

function readRedeemBody(body: unknown): RedeemBody | null {
	if (typeof body !== 'object' || body === null) {
		return null;
	}
	const candidate = body as Partial<RedeemBody>;
	if (typeof candidate.nonce !== 'string' || !NONCE_PATTERN.test(candidate.nonce)) {
		return null;
	}
	return { nonce: candidate.nonce, redeemer: candidate.redeemer, signature: candidate.signature };
}

export function createExchangePlane(deps: ExchangeDeps): Server {
	const { store, logger, onRedeemed, verifyRedemption, checkPeerTarget, isNodeStopped } = deps;
	const maxInFlight = deps.limits?.maxInFlight ?? DEFAULT_MAX_IN_FLIGHT;
	const requestsPerMinute = deps.limits?.requestsPerMinute ?? DEFAULT_REQUESTS_PER_MINUTE;
	const totalRequestsPerMinute = deps.limits?.totalRequestsPerMinute ?? DEFAULT_TOTAL_REQUESTS_PER_MINUTE;
	const maxTrackedSources = deps.limits?.maxTrackedSources ?? MAX_TRACKED_SOURCES;
	const maxBodyReaders = deps.limits?.maxBodyReaders ?? DEFAULT_MAX_BODY_READERS;
	const maxBodyReadersPerSource = deps.limits?.maxBodyReadersPerSource ?? DEFAULT_MAX_BODY_READERS_PER_SOURCE;
	const bodyTimeoutMs = deps.limits?.bodyTimeoutMs ?? DEFAULT_BODY_TIMEOUT_MS;
	let inFlight = 0;
	let bodyReaders = 0;
	const bodyReadersBySource = new Map<string, number>();
	// Per source rather than one shared counter: a single abusive caller must not
	// be able to spend the whole minute's budget and 429 the one counterparty
	// this plane exists to serve. Keyed on the socket address, which is what the
	// peer allow-list already gates on, with IPv6 grouped by /64.
	let requestWindowStartedAt = Date.now();
	const requestsInWindow = new Map<string, number>();
	let admittedInWindow = 0;
	const failuresInWindow = new Map<string, number>();

	const server = createServer((request, response) => {
		// Same search-engine exclusion as the control plane (see server.ts).
		response.setHeader('X-Robots-Tag', 'noindex, nofollow');
		// Parse the path once, up front, and guard it. A hostile request target
		// makes new URL throw, and this runs synchronously outside handle()'s
		// promise catch, so an unguarded throw would crash the whole process.
		let pathname: string;
		try {
			pathname = new URL(request.url ?? '/', 'http://exchange.invalid').pathname.replace(/\/+$/, '');
		} catch {
			send(response, 400, { error: 'bad request' });
			return;
		}
		// Answer robots.txt ahead of the limiter: Google treats a 429/5xx
		// robots.txt as a temporary full crawl block, which would hide the
		// noindex header from crawlers while the plane is saturated.
		if ((request.method === 'GET' || request.method === 'HEAD') && pathname === '/robots.txt') {
			response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
			response.end('User-agent: *\nAllow: /\n');
			return;
		}
		const now = Date.now();
		if (now - requestWindowStartedAt >= 60_000) {
			requestWindowStartedAt = now;
			requestsInWindow.clear();
			failuresInWindow.clear();
			admittedInWindow = 0;
		}
		const remote = exchangeRequestSource(
			request.socket.remoteAddress,
			request.headers['x-forwarded-for'],
			deps.trustProxy === true,
		);
		const source = rateLimitKey(rateLimitSource(remote), requestsInWindow, maxTrackedSources);
		const seen = (requestsInWindow.get(source) ?? 0) + 1;
		requestsInWindow.set(source, seen);
		// Per source first, so requests one source has no budget for never spend
		// the shared budget: one caller alone cannot exhaust it.
		if (seen > requestsPerMinute) {
			refuseOverBudget(response);
			return;
		}
		// Past the shared budget the request is not refused yet: junk from many
		// addresses can spend that budget, and refusing here would deny the real
		// counterparty until the invite expires. Instead only a redemption of an
		// open invite gets through, and the body-reader caps bound the extra reads.
		const overBudget = admittedInWindow >= totalRequestsPerMinute;
		if (!overBudget) admittedInWindow += 1;

		void handle(request, response, source, pathname, overBudget).catch((error: unknown) => {
			// Never echo the message: this is an unauthenticated surface and the
			// error text can describe internal state.
			logger.error(`[exchange] ${(error as Error).message}`);
			if (!response.headersSent && !response.destroyed) {
				send(response, 400, { error: 'bad request' });
			}
		});
	});
	server.headersTimeout = 15_000;
	server.requestTimeout = 30_000;
	server.keepAliveTimeout = 10_000;
	return server;

	async function handle(
		request: IncomingMessage,
		response: ServerResponse,
		source: string,
		pathname: string,
		overBudget: boolean,
	): Promise<void> {
		if (overBudget && (request.method !== 'POST' || pathname !== '/exchange/redeem')) {
			refuseOverBudget(response);
			return;
		}
		if (request.method !== 'POST') {
			send(response, 405, { error: 'method not allowed' });
			return;
		}

		if (pathname === '/exchange/redeem') {
			await handleRedeem(request, response, source, overBudget);
			return;
		}
		// Anything else, including every control-plane path, is simply absent
		// here. There is no proxy and no node route to reach.
		send(response, 404, { error: 'not found' });
	}

	async function handleRedeem(
		request: IncomingMessage,
		response: ServerResponse,
		source: string,
		overBudget: boolean,
	): Promise<void> {
		const sourceReaders = bodyReadersBySource.get(source) ?? 0;
		if (bodyReaders >= maxBodyReaders || sourceReaders >= maxBodyReadersPerSource) {
			response.setHeader('Connection', 'close');
			response.setHeader('Retry-After', '1');
			send(response, 503, { error: 'exchange is busy' });
			return;
		}
		bodyReaders += 1;
		bodyReadersBySource.set(source, sourceReaders + 1);
		let body: RedeemBody | null;
		try {
			body = readRedeemBody(
				await readBody(request, overBudget ? Math.min(bodyTimeoutMs, OVER_BUDGET_BODY_TIMEOUT_MS) : bodyTimeoutMs),
			);
		} catch (error) {
			// Past the budget every refusal is the same 429, including a body that
			// is not JSON or is too large; within budget handle()'s catch sends 400.
			if (!overBudget) throw error;
			if (!response.destroyed) refuseOverBudget(response);
			return;
		} finally {
			bodyReaders -= 1;
			const remaining = (bodyReadersBySource.get(source) ?? 1) - 1;
			if (remaining === 0) bodyReadersBySource.delete(source);
			else bodyReadersBySource.set(source, remaining);
		}
		if (body === null || !isExchangeMaterial(body.redeemer) || !isExchangeSignature(body.signature)) {
			if (overBudget) refuseOverBudget(response);
			else send(response, 400, { error: 'malformed redemption' });
			return;
		}

		if (inFlight >= maxInFlight) {
			response.setHeader('Retry-After', '1');
			send(response, 503, { error: 'exchange is busy' });
			return;
		}
		inFlight += 1;
		try {
			// Before the store, not after: a refused signature must leave the nonce
			// open for the real redeemer. Says nothing about whether the nonce
			// exists, so it is not counted toward the disclosure budget below.
			if (!(await verifyRedemption(body.nonce, body.redeemer, body.signature))) {
				logger.warn('[exchange] redemption refused (401 signature does not verify)');
				send(response, 401, { error: 'signature does not verify' });
				return;
			}
			// After the signature check, so a 401 stays independent of the nonce, as
			// it is within budget. An unknown, spent or expired nonce all get the same
			// 429 after the same work, so nothing here tells whether a nonce exists.
			if (overBudget && !(await isOpenInvite(body.nonce))) {
				refuseOverBudget(response);
				return;
			}
			// Only for an invite that is still open. A valid signature proves only
			// who signed, so without this any throwaway wallet could make the Host
			// resolve names it chooses. Skipping the check for a nonce that opens in
			// between is safe: `setPeers` checks the address again before the node
			// can dial it.
			const pending = (await store.listInvites()).find((invite) => invite.nonce === body.nonce);
			if (pending !== undefined && pending.redeemedAt === null) {
				// An expired invite is left to the store, which answers 410. A stop
				// that lands after this check still holds: peer setup never changes
				// the desired state, so the node stays down until started.
				if (pending.expiresAt > Date.now() && (await isNodeStopped(pending.hostNodeId))) {
					logger.warn('[exchange] redemption refused (503 reserved node is stopped)');
					response.setHeader('Retry-After', String(STOPPED_NODE_RETRY_AFTER_SECONDS));
					send(response, 503, { error: 'the reserved node is stopped; retry later' });
					return;
				}
				const peerRejection = await checkPeerTarget(body.redeemer.advertise);
				if (peerRejection !== null) {
					logger.warn(`[exchange] redemption refused (400 ${peerRejection})`);
					send(response, 400, { error: 'peer address is not allowed' });
					return;
				}
			}
			const result = await store.redeem(body.nonce, body.redeemer, body.signature);
			if (!result.ok) {
				const failures = (failuresInWindow.get(source) ?? 0) + 1;
				failuresInWindow.set(source, failures);
				// The operator sees the real reason either way: it is logged here and
				// the invite's own state is on the control plane.
				logger.warn(`[exchange] redemption refused (${result.status} ${result.reason})`);
				if (failures > MAX_DISCLOSED_REDEEM_FAILURES) {
					send(response, 404, { error: 'no such invite' });
					return;
				}
				send(response, result.status, { error: result.reason });
				return;
			}

			// The reply carries nothing the counterparty must trust — everything they
			// need was signed inside the invite — so this is an acknowledgement, and
			// the Host never has to speak for its operator's wallet.
			send(response, 200, { redeemed: true });

			// After answering: the counterparty can neither help nor wait if this
			// fails, and the failure belongs in the operator's poll.
			try {
				await onRedeemed(body.nonce, result.invite.hostNodeId);
			} catch (error) {
				const message = (error as Error).message;
				logger.error(`[exchange] node ${result.invite.hostNodeId} failed to start after redemption: ${message}`);
				await store.recordStartError(body.nonce, message).catch(() => undefined);
			}
		} finally {
			inFlight -= 1;
		}
	}

	/**
	 * Scans every invite with a constant-time compare and no early exit, so the
	 * time taken does not depend on where, or whether, the nonce matches.
	 */
	async function isOpenInvite(nonce: string): Promise<boolean> {
		const now = Date.now();
		let open = false;
		for (const invite of await store.listInvites()) {
			const matches = constantTimeEquals(invite.nonce, nonce);
			open = (matches && invite.redeemedAt === null && invite.expiresAt > now) || open;
		}
		return open;
	}
}

function refuseOverBudget(response: ServerResponse): void {
	response.setHeader('Retry-After', '60');
	send(response, 429, { error: 'too many requests' });
}
