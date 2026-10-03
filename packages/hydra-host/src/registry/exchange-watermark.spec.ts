/**
 * A redemption must never be stamped behind the watermark that skips it.
 *
 * The poller stores the `now` this Host hands back and asks for
 * `redeemedAt > since` next time. The handler used to take that `now` after
 * `await listInvites()` had resolved, while `redeem` took its own timestamp at
 * the call site, before the store's FIFO queue. A redemption enqueued behind a
 * poll therefore wrote a timestamp taken ahead of it, the poll never returned
 * it, and the next poll's `since` had already passed it: the invite stayed
 * `Issued` with no head, holding a node, its peer port and its fuel, and
 * blocking deletion of the Host until a restart fell back to the cold-start
 * lookback.
 */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExchangeStore } from './exchange-store.js';
import type { ExchangeMaterial, ExchangeSignature } from './exchange-types.js';

const REDEEMER: ExchangeMaterial = {
	hydraVerificationKey: `5820${'ab'.repeat(32)}`,
	cardanoVerificationKey: `5820${'cd'.repeat(32)}`,
	advertise: 'hydra2.example.com:5599',
	walletAddress: 'addr_test1_counterparty',
	exchangeUrl: 'https://hydra2.example.com:8444',
};
const SIGNATURE: ExchangeSignature = { key: 'aa'.repeat(32), signature: 'bb'.repeat(64) };

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
		startError: null,
	});
});

afterEach(async () => {
	await fs.rm(directory, { recursive: true, force: true });
});

describe('the redemption watermark', () => {
	it('never hands back a watermark a later redemption can fall behind', async () => {
		// Both enqueued in the same tick, poll first: the redemption's write runs
		// after the poll's read, so its stamp has to land after the poll's
		// watermark or the poller will step straight over it.
		const [polled, redeemed] = await Promise.all([
			store.listInvitesWithWatermark(),
			store.redeem('nonce-one', REDEEMER, SIGNATURE),
		]);

		expect(redeemed.ok).toBe(true);
		const stamped = (await store.listInvites())[0]?.redeemedAt;
		expect(stamped).not.toBeNull();
		expect(stamped as number).toBeGreaterThanOrEqual(polled.now);
	});

	it('returns the redemption to the next poll that uses that watermark', async () => {
		const first = await store.listInvitesWithWatermark();
		await store.redeem('nonce-one', REDEEMER, SIGNATURE);

		const { invites } = await store.listInvitesWithWatermark();
		const changed = invites.filter((invite) => invite.redeemedAt !== null && invite.redeemedAt > first.now);

		expect(changed.map((invite) => invite.nonce)).toEqual(['nonce-one']);
	});
});
