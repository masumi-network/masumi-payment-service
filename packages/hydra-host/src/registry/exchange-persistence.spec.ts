import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExchangeStore } from './exchange-store.js';
import type { ExchangeMaterial, InviteRecord } from './exchange-types.js';

const REDEEMER: ExchangeMaterial = {
	hydraVerificationKey: `5820${'ab'.repeat(32)}`,
	cardanoVerificationKey: `5820${'cd'.repeat(32)}`,
	advertise: 'peer.example.com:5001',
	walletAddress: 'addr_test1_counterparty',
	exchangeUrl: 'https://peer.example.com/exchange',
};
const SIGNATURE = { key: 'aa'.repeat(32), signature: 'bb'.repeat(64) };
let directory: string;
let store: ExchangeStore;
let invite: InviteRecord;

beforeEach(async () => {
	directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hydra-exchange-persistence-'));
	store = new ExchangeStore(directory);
	invite = {
		nonce: 'nonce-one',
		hostNodeId: 'node-1',
		expiresAt: Date.now() + 60_000,
		issuedAt: Date.now(),
		redeemedAt: null,
		redeemer: null,
		redeemerSignature: null,
		startError: null,
	};
	await store.registerInvite(invite);
});

afterEach(async () => {
	jest.restoreAllMocks();
	await fs.rm(directory, { recursive: true, force: true });
});

describe('exchange persistence failures', () => {
	it('keeps the exchange log and its temporary write private under a normal umask', async () => {
		const file = path.join(directory, 'exchange.json');
		await fs.chmod(directory, 0o755);
		const originalRename = fs.rename.bind(fs);
		const originalUmask = process.umask(0o022);
		const temporaryModes: number[] = [];
		jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
			if (to === file) temporaryModes.push((await fs.stat(from)).mode & 0o777);
			await originalRename(from, to);
		});
		try {
			await store.registerInvite({ ...invite, nonce: 'nonce-two' });
			expect(temporaryModes).toEqual([0o600]);
			expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
		} finally {
			process.umask(originalUmask);
		}
	});

	it('restricts an existing exchange log before loading its open nonces', async () => {
		const file = path.join(directory, 'exchange.json');
		await fs.chmod(directory, 0o755);
		await fs.chmod(file, 0o644);

		await new ExchangeStore(directory).listInvites();

		expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
	});

	it('keeps a failed registration invisible and permits its retry', async () => {
		const next = { ...invite, nonce: 'nonce-two' };
		jest.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('injected rename failure'));
		await expect(store.registerInvite(next)).rejects.toThrow('injected rename failure');
		expect(await store.listInvites()).toEqual([invite]);
		expect(await new ExchangeStore(directory).listInvites()).toEqual([invite]);
		await store.registerInvite(next);
		expect(await new ExchangeStore(directory).listInvites()).toHaveLength(2);
	});

	it('keeps a failed redemption unspent and permits its retry', async () => {
		jest.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('injected rename failure'));
		await expect(store.redeem(invite.nonce, REDEEMER, SIGNATURE)).rejects.toThrow('injected rename failure');
		expect((await store.listInvites())[0].redeemedAt).toBeNull();
		expect((await new ExchangeStore(directory).listInvites())[0].redeemedAt).toBeNull();
		await expect(store.redeem(invite.nonce, REDEEMER, SIGNATURE)).resolves.toMatchObject({ ok: true });
		expect((await new ExchangeStore(directory).listInvites())[0].redeemer).toEqual(REDEEMER);
	});

	it('keeps a failed deletion visible and permits its retry', async () => {
		jest.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('injected rename failure'));
		await expect(store.forgetInvite(invite.nonce)).rejects.toThrow('injected rename failure');
		expect(await store.listInvites()).toEqual([invite]);
		expect(await new ExchangeStore(directory).listInvites()).toEqual([invite]);
		await store.forgetInvite(invite.nonce);
		expect(await new ExchangeStore(directory).listInvites()).toEqual([]);
	});

	it('does not publish a start error whose write failed', async () => {
		jest.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('injected rename failure'));
		await expect(store.recordStartError(invite.nonce, 'failed start')).rejects.toThrow('injected rename failure');
		expect((await store.listInvites())[0].startError).toBeNull();
		await store.recordStartError(invite.nonce, 'failed start');
		expect((await new ExchangeStore(directory).listInvites())[0].startError).toBe('failed start');
	});
});

describe('orphan removal and invite claims', () => {
	it('refuses removal while an open invite owns the node', async () => {
		const remove = jest.fn<() => Promise<boolean>>().mockResolvedValue(true);
		await expect(store.removeUnclaimedNode(invite.hostNodeId, remove)).resolves.toBeNull();
		expect(remove).not.toHaveBeenCalled();
	});

	it('does not register an invite after removal wins the queue', async () => {
		let beginRemoval!: () => void;
		let finishRemoval!: () => void;
		const removalStarted = new Promise<void>((resolve) => {
			beginRemoval = resolve;
		});
		const mayFinishRemoval = new Promise<void>((resolve) => {
			finishRemoval = resolve;
		});
		let isRemoving = false;
		const removal = store.removeUnclaimedNode('node-2', async () => {
			isRemoving = true;
			beginRemoval();
			await mayFinishRemoval;
			return true;
		});
		await removalStarted;
		const registration = store.registerInvite({ ...invite, nonce: 'nonce-two', hostNodeId: 'node-2' }, async () => {
			if (isRemoving) throw new Error('node is being removed');
		});
		finishRemoval();
		await expect(removal).resolves.toBe(true);
		await expect(registration).rejects.toThrow('node is being removed');
		expect(await store.listInvites()).toEqual([invite]);
	});
});
