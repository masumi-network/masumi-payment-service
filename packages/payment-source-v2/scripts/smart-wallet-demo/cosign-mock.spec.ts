import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PREPROD_ZERO_TIME = 1654041600000 + 1728000000;
const PREPROD_ZERO_SLOT = 86400;
const INITIAL_SLOT = 1_000_000;
const VALIDITY_SLOTS = 600;
const MEMBER = 'ab'.repeat(28);
const WALLET = 'addr_test1zwallet';
const BATCH_A = '7f0c3d2e-9a4b-4c1d-8e2f-3a4b5c6d7e8f';
const BATCH_B = '11112222-3333-4444-5555-666677778888';
let now = PREPROD_ZERO_TIME + (INITIAL_SLOT - PREPROD_ZERO_SLOT) * 1000;
let ttl = INITIAL_SLOT + VALIDITY_SLOTS;
const sign = jest.fn<() => Promise<string>>();
const hashOf = (cbor: string) => createHash('sha256').update(cbor).digest('hex');

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
// Every symbol cosign-mock.ts (and anything it loads) takes from core-cst must
// appear here: a Jest module mock applies to the whole file regardless of which
// mesh line a transitive import would have resolved.
jest.unstable_mockModule('@meshsdk/core-cst', () => ({
	deserializeTx: () => ({
		body: () => ({
			validityStartInterval: () => INITIAL_SLOT,
			ttl: () => ttl,
			inputs: () => ({ values: () => [] }),
			outputs: () => [],
			requiredSigners: () => ({ values: () => [{ toCore: () => MEMBER }] }),
		}),
		witnessSet: () => ({ toCbor: () => 'a10081' }),
	}),
	resolveTxHash: hashOf,
	addVKeyWitnessSetToTransaction: (tx: string) => tx,
	TransactionWitnessSet: {
		fromCbor: () => ({
			vkeys: () => ({ values: () => [{ vkey: () => 'cd'.repeat(32), signature: () => 'ef'.repeat(64) }] }),
		}),
	},
	HexBlob: (value: string) => value,
	// cosign-mock.ts loads the real cosign-client for its request schema, and
	// that module imports these two for the witness merge. Unused here, but a
	// module mock must cover every symbol the file graph imports.
	Ed25519PublicKey: { fromHex: () => ({ hash: () => ({ hex: () => '' }), verify: () => false }) },
	Ed25519Signature: { fromHex: (value: string) => value },
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('@/utils/converter/string-datum-convert', () => ({
	decodeV2ContractDatum: () => null,
}));
// Reservation tests isolate the HTTP lifecycle from transaction policy and cryptography.
jest.unstable_mockModule('./cosign-policy', () => ({
	verifyIntentAgainstBody: ({
		request,
	}: {
		request: { intents: Array<{ purchaseId: string; outputIndex: number }> };
	}) => ({
		kind: 'allow',
		members: request.intents.map((intent) => ({ ...intent, verdict: 'allowed' })),
	}),
}));
const { startMockCosignServer } = await import('./cosign-mock');
let server: Awaited<ReturnType<typeof startMockCosignServer>>;
let directory: string;

function request(bodyHex: string, batchId: string) {
	return {
		batchId,
		walletUtxoRef: `${'cd'.repeat(32)}#0`,
		intents: [
			{
				purchaseId: 'pur-1',
				outputIndex: 1,
				counterparty: `sellerVkeyHash:${'12'.repeat(28)}`,
				amount: '6000000',
				asset: 'lovelace',
				jobHash: `blake2b_256:${'34'.repeat(32)}`,
				agentIdentifier: 'agent-1',
			},
		],
		context: { nodeId: 'node', orgId: 'org', submittedAt: '2026-09-16T12:00:00.000Z' },
		txBodyHex: bodyHex,
	};
}

async function post(bodyHex: string, batchId = BATCH_A, idempotencyKey = batchId) {
	const response = await fetch(`${server.url}/v1/cosign`, {
		method: 'POST',
		headers: { Authorization: 'Bearer test', 'Idempotency-Key': idempotencyKey },
		body: JSON.stringify(request(bodyHex, batchId)),
	});
	return { status: response.status, body: await response.json() };
}

/** The hash the server derives for a body: it wraps the body as `[body, {}, true, null]`. */
const bodyHashOf = (bodyHex: string) => hashOf(`84${bodyHex}a0f5f6`);

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
		maxPerIntentLovelace: 10n,
		maxValiditySlots: VALIDITY_SLOTS,
		agentVkhs: [MEMBER],
		escrowAddresses: ['addr_test1wescrow'],
		resolveWalletInput: async () => ({ address: WALLET, lovelace: 10n }),
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
	it('keeps signed budget after the 120-second rebuild hold', async () => {
		const approved = await post('aa');
		expect(approved.status).toBe(200);
		now += 121_000;
		expect((await post('bb', BATCH_B)).status).toBe(409);
		expect(sign).toHaveBeenCalledTimes(1);
	});

	it('releases only at the decoded upper slot boundary', async () => {
		await post('aa');
		now += VALIDITY_SLOTS * 1000 - 1;
		expect((await post('bb', BATCH_B)).status).toBe(409);
		now += 1;
		ttl += VALIDITY_SLOTS;
		expect((await post('cc', '99998888-7777-6666-5555-444433332222')).status).toBe(200);
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
		const outcome = await post('bb', BATCH_B);
		release();
		await first;
		expect(outcome.status).toBe(409);
		expect(sign).toHaveBeenCalledTimes(1);
	});

	it('retains the reservation after a signer fails', async () => {
		sign.mockRejectedValueOnce(new Error('signer disconnected'));
		expect((await post('aa')).status).toBe(500);
		expect((await post('bb', BATCH_B)).status).toBe(409);
	});

	it.each([INITIAL_SLOT, NaN, Infinity])('refuses invalid or expired decoded upper bound %s', async (invalidTtl) => {
		ttl = invalidTtl;
		const denial = await post('aa');
		expect(denial.status).toBe(409);
		expect(denial.body.denied).toBe('clock_skew');
		expect(sign).not.toHaveBeenCalled();
	});

	it('requires the idempotency key to be the batch id', async () => {
		expect((await post('aa', BATCH_A, BATCH_B)).status).toBe(400);
		expect(sign).not.toHaveBeenCalled();
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

	it('supersedes the stored decision when the same batch id carries a new body', async () => {
		const first = await post('aa');
		expect(first.status).toBe(200);
		const rebuilt = await post('bb');
		expect(rebuilt.status).toBe(200);
		expect(rebuilt.body.txBodyHash).toBe(`blake2b_256:${bodyHashOf('bb')}`);
		expect(sign).toHaveBeenCalledTimes(2);
	});

	it('echoes decoded fields on approvals, denials and cached replies', async () => {
		for (const [index, bodyHex] of ['aa', 'bb', 'aa', 'bb'].entries()) {
			const reply = await post(bodyHex, index % 2 === 0 ? BATCH_A : BATCH_B);
			expect(reply.body.txBodyHash).toBe(`blake2b_256:${bodyHashOf(bodyHex)}`);
			expect(reply.body.requiredSigners).toEqual([MEMBER]);
			expect(reply.body.schemaVersion).toBe('1.1');
		}
	});
});
