import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createExchangePlane } from './exchange-server.js';
import { ExchangeStore } from '../registry/exchange-store.js';

const MATERIAL = {
	walletAddress: 'addr_test1them',
	hydraVerificationKey: 'hvk',
	cardanoVerificationKey: 'cvk',
	advertise: 'them.example.com:5101',
	exchangeUrl: 'https://them.example.com/exchange',
};
const SIGNATURE = { signature: 'sig', key: 'key' };

let server: Server;
let store: ExchangeStore;
let base: string;
let dataDir: string;
let onRedeemed: jest.Mock<(nonce: string, hostNodeId: string) => Promise<void>>;

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

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
	server = createExchangePlane({ store, logger, onRedeemed });
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
		server = createExchangePlane({ store, logger, onRedeemed, limits: { requestsPerMinute: 1 } });
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
