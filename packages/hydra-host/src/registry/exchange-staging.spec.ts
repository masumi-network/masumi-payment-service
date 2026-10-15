/**
 * A redemption is staged until the owning service confirms it.
 *
 * The Exchange Plane cannot verify a signature, so a POST must not spend the
 * nonce. Before this, anyone holding an invite could post forged material
 * first, burn the nonce, and leave the intended redeemer refused.
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExchangeStore } from './exchange-store.js';
import type { ExchangeMaterial, ExchangeSignature } from './exchange-types.js';

const GENUINE: ExchangeMaterial = {
	hydraVerificationKey: `5820${'ab'.repeat(32)}`,
	cardanoVerificationKey: `5820${'cd'.repeat(32)}`,
	advertise: 'hydra2.example.com:5599',
	walletAddress: 'addr_test1_counterparty',
	exchangeUrl: 'https://hydra2.example.com:8444',
};
const GENUINE_SIGNATURE: ExchangeSignature = { key: 'aa'.repeat(32), signature: 'bb'.repeat(64) };
const FORGED: ExchangeMaterial = { ...GENUINE, walletAddress: 'addr_test1_attacker' };
const FORGED_SIGNATURE: ExchangeSignature = { key: 'cc'.repeat(32), signature: 'dd'.repeat(64) };

let directory: string;
let store: ExchangeStore;

beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hydra-exchange-'));
	store = new ExchangeStore(directory);
	await store.registerInvite({
		nonce: 'nonce-one',
		hostNodeId: 'node-1',
		expiresAt: Date.now() + 60_000,
		issuedAt: Date.now(),
		redeemedAt: null,
		redeemer: null,
		redeemerSignature: null,
		staged: [],
		startError: null,
	});
});

afterEach(async () => {
	await fs.rm(directory, { recursive: true, force: true });
});

async function stagedIds(): Promise<string[]> {
	return (await store.listInvites())[0].staged.map((candidate) => candidate.id);
}

describe('staged redemptions', () => {
	it('confirms the verified candidate and drops the forged one', async () => {
		await store.stage('nonce-one', FORGED, FORGED_SIGNATURE);
		await store.stage('nonce-one', GENUINE, GENUINE_SIGNATURE);
		const [forgedId, genuineId] = await stagedIds();

		await store.rejectStaged('nonce-one', forgedId);
		const confirmed = await store.confirmStaged('nonce-one', genuineId);

		expect(confirmed).toMatchObject({ ok: true, invite: { redeemer: GENUINE, redeemerSignature: GENUINE_SIGNATURE } });
		const [invite] = await new ExchangeStore(directory).listInvites();
		expect(invite.redeemedAt).not.toBeNull();
		expect(invite.staged).toEqual([]);
	});

	it('answers a retried confirmation of the same candidate the same way', async () => {
		await store.stage('nonce-one', GENUINE, GENUINE_SIGNATURE);
		const [genuineId] = await stagedIds();
		await store.confirmStaged('nonce-one', genuineId);
		expect(await store.confirmStaged('nonce-one', genuineId)).toMatchObject({ ok: true });
	});

	it('refuses to confirm a second candidate once the nonce is spent', async () => {
		await store.stage('nonce-one', FORGED, FORGED_SIGNATURE);
		await store.stage('nonce-one', GENUINE, GENUINE_SIGNATURE);
		const [forgedId, genuineId] = await stagedIds();
		await store.confirmStaged('nonce-one', genuineId);
		expect(await store.confirmStaged('nonce-one', forgedId)).toMatchObject({ ok: false, status: 409 });
	});

	it('refuses to confirm a candidate it never staged', async () => {
		expect(await store.confirmStaged('nonce-one', '0'.repeat(32))).toMatchObject({ ok: false, status: 404 });
	});

	it('leaves the invite open after a rejection', async () => {
		await store.stage('nonce-one', FORGED, FORGED_SIGNATURE);
		const [forgedId] = await stagedIds();
		await store.rejectStaged('nonce-one', forgedId);
		const [invite] = await store.listInvites();
		expect(invite.redeemedAt).toBeNull();
		expect(invite.staged).toEqual([]);
		expect(await store.stage('nonce-one', GENUINE, GENUINE_SIGNATURE)).toEqual({ ok: true });
	});

	it('reads records written before staging existed', async () => {
		const file = path.join(directory, 'exchange.json');
		const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { invites: Array<Record<string, unknown>> };
		delete raw.invites[0].staged;
		await fs.writeFile(file, JSON.stringify(raw));
		expect((await new ExchangeStore(directory).listInvites())[0].staged).toEqual([]);
	});
});
