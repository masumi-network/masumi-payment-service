import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MeshWallet } from '@meshsdk/core';
import { createExchangePlane } from '../api/exchange-server.js';
import { ExchangeStore } from './exchange-store.js';
import type { ExchangeMaterial, ExchangeSignature } from './exchange-types.js';
import { hashRedemptionPayload, verifyRedemptionSignature } from './redemption-signature.js';

const NETWORK = 'Preprod' as const;
const NONCE = 'nonce-signed01';

type TestWallet = { address: string; sign: (hash: string) => Promise<ExchangeSignature> };

async function testWallet(): Promise<TestWallet> {
	const wallet = new MeshWallet({ networkId: 0, key: { type: 'mnemonic', words: MeshWallet.brew() as string[] } });
	await wallet.init();
	const address = await wallet.getChangeAddress();
	return {
		address,
		sign: async (hash) => {
			const signed = await wallet.signData(hash, address);
			return { signature: signed.signature, key: signed.key };
		},
	};
}

function material(walletAddress: string): ExchangeMaterial {
	return {
		walletAddress,
		hydraVerificationKey: `5820${'11'.repeat(32)}`,
		cardanoVerificationKey: `5820${'22'.repeat(32)}`,
		advertise: 'them.example.com:5101',
		exchangeUrl: 'https://them.example.com/exchange',
	};
}

/** Flip one byte of the Ed25519 signature, the last 64 bytes of the COSE_Sign1. */
function corrupt(signature: ExchangeSignature): ExchangeSignature {
	const last = signature.signature.slice(-2);
	const flipped = (parseInt(last, 16) ^ 0x01).toString(16).padStart(2, '0');
	return { ...signature, signature: `${signature.signature.slice(0, -2)}${flipped}` };
}

let redeemer: TestWallet;
let other: TestWallet;

beforeAll(async () => {
	redeemer = await testWallet();
	other = await testWallet();
});

describe('verifyRedemptionSignature', () => {
	it('accepts a signature by the wallet the redemption names', async () => {
		const body = material(redeemer.address);
		const signature = await redeemer.sign(hashRedemptionPayload(NONCE, NETWORK, body));
		await expect(verifyRedemptionSignature(NONCE, NETWORK, body, signature)).resolves.toBe(true);
	});

	it('refuses a corrupted signature', async () => {
		const body = material(redeemer.address);
		const signature = await redeemer.sign(hashRedemptionPayload(NONCE, NETWORK, body));
		await expect(verifyRedemptionSignature(NONCE, NETWORK, body, corrupt(signature))).resolves.toBe(false);
	});

	it('refuses a malformed signature without throwing', async () => {
		const body = material(redeemer.address);
		await expect(verifyRedemptionSignature(NONCE, NETWORK, body, { signature: 'sig', key: 'key' })).resolves.toBe(
			false,
		);
	});

	// A valid signature over exactly this body, but by a key that is not behind
	// the address the body names.
	it('refuses a valid signature from a different wallet', async () => {
		const body = material(redeemer.address);
		const signature = await other.sign(hashRedemptionPayload(NONCE, NETWORK, body));
		await expect(verifyRedemptionSignature(NONCE, NETWORK, body, signature)).resolves.toBe(false);
	});

	it('refuses a signature over different material, nonce or network', async () => {
		const body = material(redeemer.address);
		const signature = await redeemer.sign(hashRedemptionPayload(NONCE, NETWORK, body));
		const tampered = { ...body, advertise: 'attacker.example.com:5101' };
		await expect(verifyRedemptionSignature(NONCE, NETWORK, tampered, signature)).resolves.toBe(false);
		await expect(verifyRedemptionSignature('nonce-signed02', NETWORK, body, signature)).resolves.toBe(false);
		await expect(verifyRedemptionSignature(NONCE, 'Mainnet', body, signature)).resolves.toBe(false);
	});
});

describe('redeeming over the Exchange Plane with real signatures', () => {
	let server: Server;
	let store: ExchangeStore;
	let base: string;
	let dataDir: string;
	const onRedeemed = jest.fn(async () => undefined);
	const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

	beforeEach(async () => {
		jest.clearAllMocks();
		dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hydra-exchange-sig-'));
		store = new ExchangeStore(dataDir);
		server = createExchangePlane({
			store,
			logger,
			onRedeemed,
			verifyRedemption: async (nonce, body, signature) =>
				await verifyRedemptionSignature(nonce, NETWORK, body, signature),
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		await store.registerInvite({
			nonce: NONCE,
			hostNodeId: 'node-1',
			expiresAt: Date.now() + 60_000,
			issuedAt: Date.now(),
			redeemedAt: null,
			redeemer: null,
			redeemerSignature: null,
			startError: null,
		});
	});

	afterEach(async () => {
		server.closeIdleConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await fs.rm(dataDir, { recursive: true, force: true });
	});

	async function redeem(body: ExchangeMaterial, signature: ExchangeSignature): Promise<number> {
		const response = await fetch(`${base}/exchange/redeem`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Connection: 'close' },
			body: JSON.stringify({ nonce: NONCE, redeemer: body, signature }),
		});
		await response.json();
		return response.status;
	}

	async function inviteIsOpen(): Promise<boolean> {
		const [invite] = await store.listInvites();
		return invite !== undefined && invite.redeemedAt === null && invite.redeemer === null;
	}

	it('does not burn the nonce on an invalid signature, then accepts the real one', async () => {
		const body = material(redeemer.address);
		const signature = await redeemer.sign(hashRedemptionPayload(NONCE, NETWORK, body));

		expect(await redeem(body, corrupt(signature))).toBe(401);
		expect(await inviteIsOpen()).toBe(true);
		expect(onRedeemed).not.toHaveBeenCalled();

		expect(await redeem(body, signature)).toBe(200);
		expect(await inviteIsOpen()).toBe(false);
	});

	it('does not burn the nonce on a valid signature from the wrong wallet', async () => {
		const body = material(redeemer.address);
		const forged = await other.sign(hashRedemptionPayload(NONCE, NETWORK, body));

		expect(await redeem(body, forged)).toBe(401);
		expect(await inviteIsOpen()).toBe(true);
		expect(onRedeemed).not.toHaveBeenCalled();

		const signature = await redeemer.sign(hashRedemptionPayload(NONCE, NETWORK, body));
		expect(await redeem(body, signature)).toBe(200);
	});
});
