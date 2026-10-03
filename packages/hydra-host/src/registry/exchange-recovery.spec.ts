import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExchangeStore } from './exchange-store.js';
import { NodeRegistryStore } from './store.js';
import type { NodeRecord } from './types.js';

let dataDir: string;
let exchange: ExchangeStore;
let nodes: NodeRegistryStore;
const material = {
	walletAddress: 'addr_test1them',
	hydraVerificationKey: `5820${'11'.repeat(32)}`,
	cardanoVerificationKey: `5820${'22'.repeat(32)}`,
	advertise: 'them.example.com:5101',
	exchangeUrl: 'https://them.example.com/exchange',
};

beforeEach(async () => {
	dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hydra-exchange-recovery-'));
	exchange = new ExchangeStore(dataDir);
	nodes = new NodeRegistryStore(dataDir);
	await exchange.registerInvite({
		nonce: 'nonce-pending',
		hostNodeId: 'node-1',
		issuedAt: Date.now(),
		expiresAt: Date.now() + 60_000,
		redeemedAt: null,
		redeemer: null,
		redeemerSignature: null,
		startError: null,
	});
});
afterEach(async () => {
	jest.restoreAllMocks();
	await fs.rm(dataDir, { recursive: true, force: true });
});

describe('redemption setup retention', () => {
	it('retains a redemption until peer setup completes, even when adoption forgets it', async () => {
		await exchange.redeem('nonce-pending', material, { signature: 'sig', key: 'key' });
		jest.spyOn(nodes, 'read').mockResolvedValue({ peers: [] } as unknown as NodeRecord);
		const forget = exchange.forgetInvite.bind(exchange) as (
			nonce: string,
			nodes: NodeRegistryStore,
		) => Promise<boolean>;
		expect(await forget('nonce-pending', nodes)).toBe(false);
		expect((await new ExchangeStore(dataDir).listInvites())[0]?.redeemer).toEqual(material);
	});

	it('allows forgetting a redeemed invite after removal is requested', async () => {
		await exchange.redeem('nonce-pending', material, { signature: 'sig', key: 'key' });
		jest.spyOn(nodes, 'read').mockResolvedValue({ peers: [], removalRequested: true } as unknown as NodeRecord);
		expect(await exchange.forgetInvite('nonce-pending', nodes)).toBe(true);
	});

	it('allows forgetting a redeemed invite after its node is missing', async () => {
		await exchange.redeem('nonce-pending', material, { signature: 'sig', key: 'key' });
		expect(await exchange.forgetInvite('nonce-pending', nodes)).toBe(true);
	});

	it('allows revoking an outstanding reservation', async () => {
		const forget = exchange.forgetInvite.bind(exchange) as (
			nonce: string,
			nodes: NodeRegistryStore,
		) => Promise<boolean>;
		await forget('nonce-pending', nodes);
		expect(await exchange.listInvites()).toEqual([]);
	});
});
