import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Socket, type AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	createExchangePlane,
	exchangeRequestSource,
	OVERFLOW_SOURCE,
	rateLimitKey,
	type ExchangeDeps,
	rateLimitSource,
} from './exchange-server.js';
import { ExchangeStore } from '../registry/exchange-store.js';

// The keys are the real shape a `.vk` envelope carries — `5820` and 32 bytes —
// because that is what the redemption is checked against: they are written
// verbatim into the files hydra-node parses at startup.
const MATERIAL = {
	walletAddress: 'addr_test1them',
	hydraVerificationKey: `5820${'11'.repeat(32)}`,
	cardanoVerificationKey: `5820${'22'.repeat(32)}`,
	advertise: 'them.example.com:5101',
	exchangeUrl: 'https://them.example.com/exchange',
};
const SIGNATURE = { signature: 'sig', key: 'key' };

let server: Server;
let store: ExchangeStore;
let base: string;
let dataDir: string;
let onRedeemed: jest.Mock<(nonce: string, hostNodeId: string) => Promise<void>>;
// Transport tests do not sign bodies; real signatures are covered in
// redemption-signature.spec.ts.
let verifyRedemption: jest.Mock<ExchangeDeps['verifyRedemption']>;

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

describe('Exchange Plane request source', () => {
	it('ignores forwarded addresses unless the proxy is trusted', () => {
		expect(exchangeRequestSource('10.0.0.2', '198.51.100.4', false)).toBe('10.0.0.2');
	});

	it('uses the address appended by the trusted proxy', () => {
		expect(exchangeRequestSource('10.0.0.2', '203.0.113.9, 198.51.100.4', true)).toBe('198.51.100.4');
		expect(exchangeRequestSource('10.0.0.2', '2001:db8::7', true)).toBe('2001:db8::7');
	});

	it('falls back to the socket address for a malformed forwarded address', () => {
		expect(exchangeRequestSource('10.0.0.2', 'attacker-controlled', true)).toBe('10.0.0.2');
	});
});

/** Poll until the value is set, for work the handler does after answering. */
async function eventually<T>(read: () => Promise<T | null>, timeoutMs = 2_000): Promise<T | null> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (value !== null || Date.now() > deadline) {
			return value;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

async function post(pathname: string, body: unknown) {
	const response = await fetch(`${base}${pathname}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Connection: 'close' },
		body: JSON.stringify(body),
	});
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeEach(async () => {
	jest.clearAllMocks();
	dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hydra-exchange-'));
	store = new ExchangeStore(dataDir);
	onRedeemed = jest.fn(async () => undefined) as typeof onRedeemed;
	verifyRedemption = jest.fn<ExchangeDeps['verifyRedemption']>(async () => true);
	server = createExchangePlane({ store, logger, onRedeemed, verifyRedemption });
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
	server.closeIdleConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await fs.rm(dataDir, { recursive: true, force: true });
});

async function issue(nonce: string, ttlMs = 60_000) {
	await store.registerInvite({
		nonce,
		hostNodeId: 'node-1',
		expiresAt: Date.now() + ttlMs,
		issuedAt: Date.now(),
		redeemedAt: null,
		redeemer: null,
		redeemerSignature: null,
		startError: null,
	});
}

describe('search-engine exclusion', () => {
	it('stamps noindex on responses and serves an allow-all robots.txt', async () => {
		const rejected = await fetch(`${base}/exchange/redeem`, { headers: { Connection: 'close' } });
		expect(rejected.status).toBe(405);
		expect(rejected.headers.get('x-robots-tag')).toBe('noindex, nofollow');

		const robots = await fetch(`${base}/robots.txt`, { headers: { Connection: 'close' } });
		expect(robots.status).toBe(200);
		expect(robots.headers.get('x-robots-tag')).toBe('noindex, nofollow');
		expect(await robots.text()).toBe('User-agent: *\nAllow: /\n');
	});

	// The path parse runs synchronously outside handle()'s promise catch, so a
	// throw would crash this unauthenticated process. fetch cannot send a
	// malformed request target, so drive it over a raw socket.
	it('answers a malformed request target with 400 instead of crashing', async () => {
		const port = (server.address() as AddressInfo).port;
		const statusLine = await new Promise<string>((resolve, reject) => {
			const socket = new Socket();
			let data = '';
			socket.setTimeout(2_000, () => socket.destroy(new Error('timed out')));
			socket.connect(port, '127.0.0.1', () => socket.write('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
			socket.on('data', (chunk) => (data += chunk.toString()));
			socket.on('close', () => resolve(data.split('\r\n')[0] ?? ''));
			socket.on('error', reject);
		});
		expect(statusLine).toContain('400');
		// The process survived: a normal request still answers.
		expect((await fetch(`${base}/robots.txt`, { headers: { Connection: 'close' } })).status).toBe(200);
	});

	// robots.txt must be answered ahead of the limiter: a 429/5xx robots.txt is
	// a temporary full crawl block that would hide the noindex header.
	it('serves robots.txt even when the rate limiter is saturated', async () => {
		const limited = createExchangePlane({
			store,
			logger,
			onRedeemed,
			verifyRedemption,
			limits: { requestsPerMinute: 1 },
		});
		await new Promise<void>((resolve) => limited.listen(0, '127.0.0.1', resolve));
		const limitedBase = `http://127.0.0.1:${(limited.address() as AddressInfo).port}`;
		try {
			expect((await fetch(`${limitedBase}/exchange/redeem`, { headers: { Connection: 'close' } })).status).toBe(405);
			expect((await fetch(`${limitedBase}/exchange/redeem`, { headers: { Connection: 'close' } })).status).toBe(429);
			const robots = await fetch(`${limitedBase}/robots.txt`, { headers: { Connection: 'close' } });
			expect(robots.status).toBe(200);
			expect(await robots.text()).toBe('User-agent: *\nAllow: /\n');
		} finally {
			await new Promise<void>((resolve) => limited.close(() => resolve()));
		}
	});
});

describe('redeeming an invite', () => {
	it('accepts a redemption for an invite this host issued', async () => {
		await issue('nonce-aaaaaaaa');

		const result = await post('/exchange/redeem', {
			nonce: 'nonce-aaaaaaaa',
			redeemer: MATERIAL,
			signature: SIGNATURE,
		});

		expect(result.status).toBe(200);
		expect(result.body).toEqual({ redeemed: true });
	});

	// The whole point of pre-allocation: the reply carries nothing the
	// counterparty has to trust, so the Host never signs anything.
	it('answers with an acknowledgement carrying no material', async () => {
		await issue('nonce-bbbbbbbb');
		const result = await post('/exchange/redeem', {
			nonce: 'nonce-bbbbbbbb',
			redeemer: MATERIAL,
			signature: SIGNATURE,
		});
		expect(Object.keys(result.body)).toEqual(['redeemed']);
	});

	it('starts the reserved node with the redeemer as its peer', async () => {
		await issue('nonce-cccccccc');
		await post('/exchange/redeem', { nonce: 'nonce-cccccccc', redeemer: MATERIAL, signature: SIGNATURE });
		expect(onRedeemed).toHaveBeenCalledWith('nonce-cccccccc', 'node-1');
	});

	it('refuses a second redemption of the same nonce', async () => {
		await issue('nonce-dddddddd');
		await post('/exchange/redeem', { nonce: 'nonce-dddddddd', redeemer: MATERIAL, signature: SIGNATURE });

		const second = await post('/exchange/redeem', {
			nonce: 'nonce-dddddddd',
			redeemer: MATERIAL,
			signature: SIGNATURE,
		});
		expect(second.status).toBe(409);
		expect(onRedeemed).toHaveBeenCalledTimes(1);
	});

	it('refuses a redemption whose signature does not verify, leaving the nonce open', async () => {
		await issue('nonce-ffffffff');
		verifyRedemption.mockResolvedValueOnce(false);

		const refused = await post('/exchange/redeem', {
			nonce: 'nonce-ffffffff',
			redeemer: MATERIAL,
			signature: SIGNATURE,
		});
		expect(refused.status).toBe(401);
		expect(refused.body).toEqual({ error: 'signature does not verify' });
		expect(verifyRedemption).toHaveBeenCalledWith('nonce-ffffffff', MATERIAL, SIGNATURE);
		expect(onRedeemed).not.toHaveBeenCalled();
		const [invite] = await store.listInvites();
		expect(invite?.redeemedAt).toBeNull();
		expect(invite?.redeemer).toBeNull();

		// The real redeemer can still use it.
		const accepted = await post('/exchange/redeem', {
			nonce: 'nonce-ffffffff',
			redeemer: MATERIAL,
			signature: SIGNATURE,
		});
		expect(accepted.status).toBe(200);
	});

	it('refuses a nonce it never issued', async () => {
		const result = await post('/exchange/redeem', {
			nonce: 'nonce-unknown00',
			redeemer: MATERIAL,
			signature: SIGNATURE,
		});
		expect(result.status).toBe(404);
		expect(onRedeemed).not.toHaveBeenCalled();
	});

	it('refuses an expired invite', async () => {
		await issue('nonce-eeeeeeee', -1_000);
		const result = await post('/exchange/redeem', {
			nonce: 'nonce-eeeeeeee',
			redeemer: MATERIAL,
			signature: SIGNATURE,
		});
		expect(result.status).toBe(410);
		expect(onRedeemed).not.toHaveBeenCalled();
	});

	it('rejects material that is missing fields', async () => {
		await issue('nonce-ffffffff');
		const result = await post('/exchange/redeem', {
			nonce: 'nonce-ffffffff',
			redeemer: { walletAddress: 'addr_test1them' },
			signature: SIGNATURE,
		});
		expect(result.status).toBe(400);
	});

	it('rejects peer addresses containing nftables syntax before redeeming the nonce', async () => {
		await issue('nonce-injection');
		const result = await post('/exchange/redeem', {
			nonce: 'nonce-injection',
			redeemer: { ...MATERIAL, advertise: 'peer.example:5001 } accept\n}\nflush ruleset\n# :5101' },
			signature: SIGNATURE,
		});

		expect(result.status).toBe(400);
		expect(onRedeemed).not.toHaveBeenCalled();
		expect((await store.listInvites())[0].redeemedAt).toBeNull();
	});

	// A node that fails to start must not report success to the counterparty as
	// an error either: they cannot act on it, and the operator can.
	it('still acknowledges when the node fails to start, and records why', async () => {
		await issue('nonce-gggggggg');
		onRedeemed.mockRejectedValueOnce(new Error('etcd refused the cluster'));

		const result = await post('/exchange/redeem', {
			nonce: 'nonce-gggggggg',
			redeemer: MATERIAL,
			signature: SIGNATURE,
		});

		// The acknowledgement is sent before the node is touched, so the error is
		// recorded after the response the test already has.
		expect(result.status).toBe(200);
		expect(await eventually(async () => (await store.listInvites())[0].startError)).toBe('etcd refused the cluster');
	});
});

describe('public surface hardening', () => {
	it('rate-limits the anonymous endpoint before work reaches the store', async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		server = createExchangePlane({ store, logger, onRedeemed, verifyRedemption, limits: { requestsPerMinute: 1 } });
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

		const first = await post('/not-found', {});
		const second = await post('/not-found', {});
		expect(first.status).toBe(404);
		expect(second.status).toBe(429);
	});

	it('does not expose an unauthenticated invite inbox', async () => {
		const result = await post('/exchange/invite', {
			nonce: 'inbound-nonce1',
			payload: '{"headSequence":1}',
			signature: SIGNATURE,
			issuerWalletAddress: 'addr_test1known',
		});
		expect(result.status).toBe(404);
	});

	it('uses short connection timeouts on the public listener', () => {
		expect(server.headersTimeout).toBe(15_000);
		expect(server.requestTimeout).toBe(30_000);
		expect(server.keepAliveTimeout).toBe(10_000);
	});
});

describe('what the exchange plane does not expose', () => {
	// The reason this is a second listener rather than a path on the control
	// plane: no routing mistake can make fleet management reachable here.
	it.each([
		'/v1/nodes',
		'/v1/capabilities',
		'/v1/invites',
		'/v1/allowed-issuers',
		'/v1/nodes/node-1/api/config',
		'/v1/peer-allowlist',
	])('has no route for %s', async (pathname) => {
		const result = await post(pathname, {});
		expect(result.status).toBe(404);
	});

	it('refuses any method other than POST', async () => {
		const response = await fetch(`${base}/exchange/redeem`, { method: 'GET' });
		expect(response.status).toBe(405);
	});

	it('never echoes an internal error message', async () => {
		await issue('nonce-hhhhhhhh');
		onRedeemed.mockRejectedValueOnce(new Error('/data/nodes/node-1/keys/hydra.sk is unreadable'));
		const result = await post('/exchange/redeem', {
			nonce: 'nonce-hhhhhhhh',
			redeemer: MATERIAL,
			signature: SIGNATURE,
		});
		expect(JSON.stringify(result.body)).not.toContain('hydra.sk');
		// Settle the write this triggered before the fixture removes the data
		// directory out from under it.
		await eventually(async () => (await store.listInvites())[0].startError);
	});
});

/**
 * The per-source counter keeps one abusive caller from spending the whole
 * minute's budget, but the caller chooses the key. This plane is
 * unauthenticated and reachable from anywhere, so an attacker holding an IPv6
 * /64 can present a fresh address per connection and the map grows with the
 * flood instead of bounding it.
 */
describe('rateLimitKey', () => {
	it('keys on the source while there is room', () => {
		const tracked = new Map<string, number>([['198.51.100.1', 1]]);
		expect(rateLimitKey('198.51.100.2', tracked, 10)).toBe('198.51.100.2');
	});

	it('keeps counting a source it already tracks, even at the cap', () => {
		const tracked = new Map<string, number>([['198.51.100.1', 4]]);
		expect(rateLimitKey('198.51.100.1', tracked, 1)).toBe('198.51.100.1');
	});

	it('folds every further source into one bucket at the cap', () => {
		const tracked = new Map<string, number>([['198.51.100.1', 1]]);
		expect(rateLimitKey('198.51.100.2', tracked, 1)).toBe(OVERFLOW_SOURCE);
		expect(rateLimitKey('2001:db8::99', tracked, 1)).toBe(OVERFLOW_SOURCE);
	});
});

describe('rateLimitSource', () => {
	it('keeps IPv4 sources as they are', () => {
		expect(rateLimitSource('198.51.100.1')).toBe('198.51.100.1');
		expect(rateLimitSource('unknown')).toBe('unknown');
	});

	it('unwraps IPv4 mapped into IPv6', () => {
		expect(rateLimitSource('::ffff:198.51.100.1')).toBe('198.51.100.1');
		expect(rateLimitSource('::ffff:c633:6401')).toBe('198.51.100.1');
		expect(rateLimitSource('0:0:0:0:0:FFFF:198.51.100.1')).toBe('198.51.100.1');
		expect(rateLimitSource('0::ffff:198.51.100.1%eth0')).toBe('198.51.100.1');
	});

	it('groups every address in one IPv6 /64', () => {
		const key = rateLimitSource('2001:db8:1:2::1');
		expect(key).toBe('2001:db8:1:2::/64');
		expect(rateLimitSource('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe(key);
		expect(rateLimitSource('2001:0DB8:0001:0002:0:0:0:9')).toBe(key);
		expect(rateLimitSource('2001:db8:1:2::1%eth0')).toBe(key);
	});

	it('separates different IPv6 /64s', () => {
		expect(rateLimitSource('2001:db8:1:3::1')).not.toBe(rateLimitSource('2001:db8:1:2::1'));
		expect(rateLimitSource('::1')).toBe('0:0:0:0::/64');
		expect(rateLimitSource('2001:db8::')).toBe('2001:db8:0:0::/64');
		expect(rateLimitSource('64:ff9b::198.51.100.1')).toBe('64:ff9b:0:0::/64');
	});
});

describe('total request budget', () => {
	let limited: Server;
	let url: string;

	beforeEach(async () => {
		limited = createExchangePlane({
			store,
			logger,
			onRedeemed,
			verifyRedemption,
			trustProxy: true,
			limits: { requestsPerMinute: 2, totalRequestsPerMinute: 5 },
		});
		await new Promise<void>((resolve) => limited.listen(0, '127.0.0.1', resolve));
		url = `http://127.0.0.1:${(limited.address() as AddressInfo).port}/exchange/redeem`;
	});

	afterEach(async () => {
		jest.restoreAllMocks();
		limited.closeAllConnections();
		await new Promise<void>((resolve) => limited.close(() => resolve()));
	});

	const from = (source: string, body = '{}') =>
		fetch(url, { method: 'POST', headers: { Connection: 'close', 'X-Forwarded-For': source }, body }).then(
			(response) => response.status,
		);
	const redeem = (source: string, nonce: string) =>
		from(source, JSON.stringify({ nonce, redeemer: MATERIAL, signature: SIGNATURE }));

	it('stops a flood from many distinct addresses, then still serves a redemption', async () => {
		const statuses: number[] = [];
		// Each address sends once, far under its own limit of 2, so only the
		// total budget can refuse them.
		for (let index = 1; index <= 20; index += 1) {
			statuses.push(await from(`198.51.100.${index}`));
		}
		expect(statuses.slice(0, 5)).toEqual([400, 400, 400, 400, 400]);
		expect(statuses.slice(5).every((status) => status === 429)).toBe(true);

		await issue('nonce-afterflood');
		expect(await redeem('203.0.113.9', 'nonce-afterflood')).toBe(429);

		const realNow = Date.now.bind(Date);
		jest.spyOn(Date, 'now').mockImplementation(() => realNow() + 61_000);
		await issue('nonce-afterflood2');
		expect(await redeem('203.0.113.9', 'nonce-afterflood2')).toBe(200);
	});

	it('does not let one source spend the shared budget', async () => {
		for (let index = 0; index < 10; index += 1) {
			await from('198.51.100.1');
		}
		const others = [await from('198.51.100.2'), await from('198.51.100.3')];
		expect(others).toEqual([400, 400]);
	});

	it('counts addresses in one IPv6 /64 as one source', async () => {
		const statuses = [await from('2001:db8::1'), await from('2001:db8::2'), await from('2001:db8::3')];
		expect(statuses).toEqual([400, 400, 429]);
		expect(await from('2001:db8:0:1::1')).toBe(400);
	});
});

/**
 * `no such invite`, `already redeemed` and `expired` are three answers, and the
 * difference tells a caller whether a nonce they guessed exists. A real
 * counterparty redeems once and wants the reason; an enumerator asks
 * repeatedly, so the reason is disclosed for the first few failures per source
 * and withheld after that.
 */
describe('redemption failure disclosure', () => {
	async function redeem(nonce: string) {
		return await post('/exchange/redeem', { nonce, redeemer: MATERIAL, signature: SIGNATURE });
	}

	it('still tells a genuine caller why their redemption failed', async () => {
		await issue('nonce-disclose1', -1_000);
		await issue('nonce-disclose2');
		await redeem('nonce-disclose2');

		expect((await redeem('nonce-disclose1')).body.error).toBe('invite expired');
		expect((await redeem('nonce-disclose2')).body.error).toBe('invite already redeemed');
	});

	it('stops distinguishing a spent nonce from an unknown one after a few tries', async () => {
		await issue('nonce-probe0001');
		await redeem('nonce-probe0001');

		const answers: Array<{ status: number; error: unknown }> = [];
		for (let attempt = 0; attempt < 6; attempt++) {
			const spent = await redeem('nonce-probe0001');
			answers.push({ status: spent.status, error: spent.body.error });
		}

		// The first few are still 409, then every answer matches what an unknown
		// nonce returns, so the two are no longer distinguishable.
		const unknown = await redeem('nonce-neverissued');
		const last = answers[answers.length - 1];
		expect(last.status).toBe(unknown.status);
		expect(last.error).toBe(unknown.body.error);
		expect(last.status).toBe(404);
		expect(answers[0].status).toBe(409);
	});
});

describe('incomplete redemption bodies', () => {
	async function openIncomplete(target: Server): Promise<Socket> {
		const socket = new Socket();
		await new Promise<void>((resolve, reject) => {
			socket.once('error', reject);
			socket.connect((target.address() as AddressInfo).port, '127.0.0.1', () => {
				socket.write('POST /exchange/redeem HTTP/1.1\r\nHost: x\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n{');
				resolve();
			});
		});
		return socket;
	}

	it('keeps redemption slots available while bodies remain incomplete', async () => {
		const limited = createExchangePlane({ store, logger, onRedeemed, verifyRedemption, limits: { maxInFlight: 1 } });
		await new Promise<void>((resolve) => limited.listen(0, '127.0.0.1', resolve));
		const socket = await openIncomplete(limited);
		try {
			await issue('nonce-bodyread1');
			const response = await fetch(`http://127.0.0.1:${(limited.address() as AddressInfo).port}/exchange/redeem`, {
				method: 'POST',
				headers: { Connection: 'close' },
				body: JSON.stringify({ nonce: 'nonce-bodyread1', redeemer: MATERIAL, signature: SIGNATURE }),
			});
			expect(response.status).toBe(200);
		} finally {
			socket.destroy();
			limited.closeAllConnections();
			await new Promise<void>((resolve) => limited.close(() => resolve()));
		}
	});

	it('bounds readers per source while another source can redeem', async () => {
		const limited = createExchangePlane({
			store,
			logger,
			onRedeemed,
			verifyRedemption,
			trustProxy: true,
			limits: { maxInFlight: 16, ...{ maxBodyReaders: 2, maxBodyReadersPerSource: 1 } },
		});
		await new Promise<void>((resolve) => limited.listen(0, '127.0.0.1', resolve));
		const socket = await openIncomplete(limited);
		const url = `http://127.0.0.1:${(limited.address() as AddressInfo).port}/exchange/redeem`;
		try {
			await issue('nonce-bodyread3');
			const body = JSON.stringify({ nonce: 'nonce-bodyread3', redeemer: MATERIAL, signature: SIGNATURE });
			const blocked = await fetch(url, { method: 'POST', headers: { Connection: 'close' }, body });
			expect(blocked.status).toBe(503);
			const allowed = await fetch(url, {
				method: 'POST',
				headers: { Connection: 'close', 'X-Forwarded-For': '198.51.100.7' },
				body,
			});
			expect(allowed.status).toBe(200);
		} finally {
			socket.destroy();
			limited.closeAllConnections();
			await new Promise<void>((resolve) => limited.close(() => resolve()));
		}
	});

	it('closes incomplete bodies at an absolute deadline and releases reader capacity', async () => {
		const limited = createExchangePlane({
			store,
			logger,
			onRedeemed,
			verifyRedemption,
			limits: { maxInFlight: 1, ...{ bodyTimeoutMs: 40, maxBodyReaders: 1 } },
		});
		await new Promise<void>((resolve) => limited.listen(0, '127.0.0.1', resolve));
		const socket = await openIncomplete(limited);
		try {
			await new Promise<void>((resolve, reject) => {
				const drip = setInterval(() => socket.write(' '), 10);
				const deadline = setTimeout(() => {
					clearInterval(drip);
					socket.destroy();
					reject(new Error('body deadline did not close the socket'));
				}, 500);
				socket.once('close', () => {
					clearInterval(drip);
					clearTimeout(deadline);
					resolve();
				});
			});
			await issue('nonce-bodyread2');
			const response = await fetch(`http://127.0.0.1:${(limited.address() as AddressInfo).port}/exchange/redeem`, {
				method: 'POST',
				headers: { Connection: 'close' },
				body: JSON.stringify({ nonce: 'nonce-bodyread2', redeemer: MATERIAL, signature: SIGNATURE }),
			});
			expect(response.status).toBe(200);
		} finally {
			socket.destroy();
			limited.closeAllConnections();
			await new Promise<void>((resolve) => limited.close(() => resolve()));
		}
	});
});
