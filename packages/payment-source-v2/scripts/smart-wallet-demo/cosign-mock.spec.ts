import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PREPROD_ZERO_TIME = 1654041600000 + 1728000000;
const PREPROD_ZERO_SLOT = 86400;
const INITIAL_SLOT = 1_000_000;
const VALIDITY_SLOTS = 600;
const MEMBER = 'ab'.repeat(28);
let now = PREPROD_ZERO_TIME + (INITIAL_SLOT - PREPROD_ZERO_SLOT) * 1000;
let ttl = INITIAL_SLOT + VALIDITY_SLOTS;
const sign = jest.fn<() => Promise<string>>();

jest.unstable_mockModule('@meshsdk/core', () => ({
	MeshWallet: class {
		getUnusedAddresses = async () => ['member-address'];
		signTx = sign;
	},
	resolvePaymentKeyHash: () => MEMBER,
	deserializeDatum: () => null,
	SLOT_CONFIG_NETWORK: { preprod: { zeroTime: PREPROD_ZERO_TIME, zeroSlot: PREPROD_ZERO_SLOT, slotLength: 1000 } },
	slotToBeginUnixTime: (slot: number, config: { zeroTime: number; zeroSlot: number; slotLength: number }) =>
		config.zeroTime + (slot - config.zeroSlot) * config.slotLength,
}));
jest.unstable_mockModule('@meshsdk/core-cst', () => ({
	deserializeTx: () => ({
		body: () => ({
			validityStartInterval: () => INITIAL_SLOT,
			ttl: () => ttl,
			inputs: () => ({ values: () => [] }),
			outputs: () => [],
			requiredSigners: () => ({ values: () => [{ toCore: () => MEMBER }] }),
		}),
	}),
	resolveTxHash: (cbor: string) => cbor.repeat(32),
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('@/utils/converter/string-datum-convert', () => ({
	decodeV2ContractDatum: () => null,
}));
jest.unstable_mockModule('./cosign-proposal-client', () => ({
	cosignRequestSchema: { safeParse: (data: unknown) => ({ success: true, data }) },
	decodeCosignBodyEcho: (cbor: string) => ({ txBodyHash: cbor.repeat(32), requiredSigners: [MEMBER] }),
}));
// Reservation tests isolate the HTTP lifecycle from transaction policy and cryptography.
jest.unstable_mockModule('./cosign-policy', () => ({ verifyIntentAgainstBody: () => ({ ok: true }) }));
const { startMockCosignServer } = await import('./cosign-mock');
let server: Awaited<ReturnType<typeof startMockCosignServer>>;
let directory: string;

function request(cbor: string) {
	return {
		txCbor: cbor,
		txHash: cbor.repeat(32),
		network: 'preprod',
		wallet: { input: { txHash: 'cd'.repeat(32), outputIndex: 0 } },
		requiredSigners: [MEMBER],
		intent: { locks: [], outflowLovelace: '1' },
		reservationTtlSeconds: 120,
	};
}
async function post(cbor: string, txHash = cbor.repeat(32)) {
	const body = { ...request(cbor), txHash };
	const response = await fetch(`${server.url}/v1/cosign`, {
		method: 'POST',
		headers: { Authorization: 'Bearer test', 'Idempotency-Key': body.txHash },
		body: JSON.stringify(body),
	});
	return { status: response.status, body: await response.json() };
}

beforeEach(async () => {
	now = PREPROD_ZERO_TIME + (INITIAL_SLOT - PREPROD_ZERO_SLOT) * 1000;
	ttl = INITIAL_SLOT + VALIDITY_SLOTS;
	jest.spyOn(Date, 'now').mockImplementation(() => now);
	sign.mockReset().mockResolvedValue('aabb');
	directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cosign-reservation-'));
	server = await startMockCosignServer({
		memberMnemonics: ['test'],
		apiKey: 'test',
		threshold: 1,
		maxOutflowLovelace: 10n,
		maxValiditySlots: VALIDITY_SLOTS,
		resolveInputLovelace: async () => 10n,
		decisionsFile: path.join(directory, 'decisions.jsonl'),
		port: 0,
	});
});
afterEach(async () => {
	await server?.close();
	fs.rmSync(directory, { recursive: true, force: true });
	jest.restoreAllMocks();
});

describe('signed mock reservations follow decoded validity', () => {
	it('keeps signed budget after the supplied 120-second TTL', async () => {
		const approved = await post('aa');
		expect(approved.status).toBe(200);
		expect(approved.body.expiresAt).toBe(new Date(now + VALIDITY_SLOTS * 1000).toISOString());
		now += 121_000;
		expect((await post('bb')).status).toBe(409);
		expect(sign).toHaveBeenCalledTimes(1);
	});
	it('releases only at the decoded upper slot boundary', async () => {
		await post('aa');
		now += VALIDITY_SLOTS * 1000 - 1;
		expect((await post('bb')).status).toBe(409);
		now += 1;
		ttl += VALIDITY_SLOTS;
		expect((await post('cc')).status).toBe(200);
	});
	it('reserves before asynchronous signing lets another body enter', async () => {
		let started!: () => void;
		let release!: () => void;
		const signingStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const signingReleased = new Promise<void>((resolve) => {
			release = resolve;
		});
		sign.mockImplementation(async () => {
			if (sign.mock.calls.length === 1) {
				started();
				await signingReleased;
			}
			return 'aabb';
		});
		const first = post('aa');
		await signingStarted;
		const outcome = await post('bb');
		release();
		await first;
		expect(outcome.status).toBe(409);
		expect(sign).toHaveBeenCalledTimes(1);
	});
	it('retains the reservation after a signer fails', async () => {
		sign.mockRejectedValueOnce(new Error('signer disconnected'));
		expect((await post('aa')).status).toBe(500);
		expect((await post('bb')).status).toBe(409);
	});
	it.each([INITIAL_SLOT, NaN, Infinity])('refuses invalid or expired decoded upper bound %s', async (invalidTtl) => {
		ttl = invalidTtl;
		expect((await post('aa')).status).toBe(409);
		expect(sign).not.toHaveBeenCalled();
	});
	it('rejects a changed body before looking up a supplied cached hash', async () => {
		expect((await post('aa')).status).toBe(200);
		expect((await post('bb', 'aa'.repeat(32))).status).toBe(400);
		expect(sign).toHaveBeenCalledTimes(1);
	});
	it('replays identical approval witnesses without signing again', async () => {
		sign.mockResolvedValueOnce('aabb').mockResolvedValueOnce('ccdd');
		const first = await post('aa');
		expect(first.status).toBe(200);
		now += 1_000;
		const replay = await post('aa');
		expect(replay).toEqual(first);
		expect(sign).toHaveBeenCalledTimes(1);
	});
	it('echoes decoded fields on approvals, denials and cached replies', async () => {
		for (const cbor of ['aa', 'bb', 'aa', 'bb']) {
			const reply = await post(cbor);
			expect(reply.body.txBodyHash).toBe(cbor.repeat(32));
			expect(reply.body.requiredSigners).toEqual([MEMBER]);
		}
	});
});
