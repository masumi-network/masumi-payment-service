import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { FixedTransaction } from '@emurgo/cardano-serialization-lib-nodejs';
import { DEFAULT_PROTOCOL_PARAMETERS, MeshWallet, type UTxO } from '@meshsdk/core';
import { logger } from '@masumi/payment-core/logger';
import { Network } from '@/generated/prisma/client';
import { encrypt } from '@/utils/security/encryption';
import { readHydraSignedTransactionShape } from '@/lib/hydra/hydra/signed-transaction-shape';
import { encodeL2ReleaseNudgeDatum, readL2ReleaseNudgeProof } from './l2-release-nudge-proof';
import {
	L2_RELEASE_NUDGE_INTERVAL_MS,
	nudgeIdleHeadForRelease,
	resetL2ReleaseNudgeThrottle,
	selectReleaseNudgeInputs,
	signInHeadSpendNudge,
	sumNudgeInputValue,
	toUtxoRef,
} from './l2-reservation-nudge';

jest.spyOn(logger, 'warn').mockImplementation(() => logger);
jest.spyOn(logger, 'info').mockImplementation(() => logger);

const address =
	'addr_test1qp6ctf8vcjxzd53et7p0hlqyncn59stnfd4g8mp978v33r6dlzjvt4s2t6wn3v993pu9aea4h3z0jeyn6lsvw6hugtesfx55dd';
const TEST_MNEMONIC = (MeshWallet.brew(false) as string[]).join(' ');
const TOKEN = `${'ab'.repeat(28)}746f6b656e`;

function utxo(txHashChar: string, outputIndex: number, overrides: Partial<UTxO['output']> = {}): UTxO {
	return {
		input: { txHash: txHashChar.repeat(64), outputIndex },
		output: { address, amount: [{ unit: 'lovelace', quantity: '5000000' }], ...overrides },
	};
}

const lockInputA = utxo('a', 0);
const lockInputB = utxo('b', 1, {
	amount: [
		{ unit: 'lovelace', quantity: '3000000' },
		{ unit: TOKEN, quantity: '7' },
	],
	plutusData: 'd87980',
});
const reservedRefs = [toUtxoRef(lockInputA), toUtxoRef(lockInputB), `${'d'.repeat(64)}#0`];

describe('selectReleaseNudgeInputs', () => {
	const select = (utxos: UTxO[], options: { pendingIncrementRefs?: Set<string>; verified?: Set<string> } = {}) =>
		selectReleaseNudgeInputs({
			utxos,
			address,
			reservedRefs,
			pendingIncrementRefs: options.pendingIncrementRefs ?? new Set(),
			isVerified: (reference: string) => options.verified?.has(reference) ?? true,
		});

	it('picks only inputs of the body at the wallet address, lowest reference first', () => {
		const unreserved = utxo('c', 0);
		expect(select([lockInputB, unreserved, lockInputA]).map(toUtxoRef)).toEqual([
			toUtxoRef(lockInputA),
			toUtxoRef(lockInputB),
		]);
	});

	it.each([
		['a reference script', { scriptRef: '82' }],
		['another address', { address: 'addr_test1other' }],
	] as const)('skips an input with %s', (_label, overrides) => {
		expect(select([utxo('a', 0, overrides as Partial<UTxO['output']>)])).toEqual([]);
	});

	it('skips pending increments and anything outside the verified snapshot', () => {
		expect(
			select([lockInputA, lockInputB], {
				pendingIncrementRefs: new Set([toUtxoRef(lockInputA)]),
				verified: new Set([toUtxoRef(lockInputA)]),
			}),
		).toEqual([]);
	});
});

describe('sumNudgeInputValue', () => {
	it('sums every unit, lovelace first', () => {
		expect(sumNudgeInputValue([lockInputB, lockInputA])).toEqual([
			{ unit: 'lovelace', quantity: '8000000' },
			{ unit: TOKEN, quantity: '7' },
		]);
	});
});

describe('signInHeadSpendNudge', () => {
	it('builds one nonce-tagged output carrying the full value, which the release proof accepts', async () => {
		const datumHex = encodeL2ReleaseNudgeDatum(new Uint8Array(32).fill(9));
		const signedTx = await signInHeadSpendNudge({
			inputs: [lockInputA, lockInputB],
			address,
			datumHex,
			network: Network.Preprod,
			encryptedMnemonic: encrypt(TEST_MNEMONIC),
			provider: {
				fetchAddressUTxOs: async () => [],
				fetchProtocolParameters: async () => DEFAULT_PROTOCOL_PARAMETERS,
			} as never,
		});

		const shape = readHydraSignedTransactionShape(signedTx);
		expect(shape?.inputRefs.sort()).toEqual([toUtxoRef(lockInputA), toUtxoRef(lockInputB)].sort());
		expect(shape?.outputs).toHaveLength(1);
		expect(shape?.outputs[0].inlineDatumHex).toBe(datumHex);
		expect(readL2ReleaseNudgeProof(signedTx, reservedRefs)).not.toBeNull();
		// The head charges no fee, so the output holds every input's value.
		const body = FixedTransaction.from_hex(signedTx).body();
		expect(body.fee().to_str()).toBe('0');
		const value = body.outputs().get(0).amount();
		expect(value.coin().to_str()).toBe('8000000');
		expect(value.multiasset()?.to_js_value()).toEqual({ [TOKEN.slice(0, 56)]: { [TOKEN.slice(56)]: '7' } });
	});
});

describe('nudgeIdleHeadForRelease', () => {
	const nowMs = 10_000_000;
	const validNudge = 'valid-nudge';

	beforeEach(() => resetL2ReleaseNudgeThrottle());

	function harness(
		options: {
			wallet?: boolean;
			decommit?: boolean;
			pendingDecommits?: readonly string[];
			recordedCount?: number;
			noHead?: boolean;
			utxos?: UTxO[];
		} = {},
	) {
		const database = {
			hotWallet: {
				findFirst: jest.fn(async (_args: unknown) =>
					options.wallet === false
						? null
						: {
								walletAddress: address,
								Secret: { encryptedMnemonic: 'encrypted' },
								PaymentSource: { network: Network.Preprod },
							},
				),
			},
			hydraDecommit: { findFirst: jest.fn(async () => (options.decommit ? { id: 'decommit-1' } : null)) },
			transaction: { updateMany: jest.fn(async (_args: unknown) => ({ count: options.recordedCount ?? 1 })) },
		};
		const node = {
			verifiedSnapshotNumber: 7n as bigint | undefined,
			getVerifiedCurrentOutput: jest.fn((_reference: string, _number: bigint): string | null => 'output-bytes'),
			pendingIncrementUtxoRefs: new Set<string>(),
			fetchPendingDecommitRefs: jest.fn(async () => [...(options.pendingDecommits ?? [])]),
		};
		const provider = {
			fetchAddressUTxOs: jest.fn(async (_address: string) => options.utxos ?? [lockInputA, lockInputB, utxo('c', 0)]),
			fetchProtocolParameters: jest.fn(),
		};
		const head = { newTx: jest.fn(async (_transaction: unknown) => 'e'.repeat(64)) };
		// A real nudge over the inputs it was given, so the proof check runs.
		const signSpendNudge = jest.fn(async (params: { inputs: readonly UTxO[]; datumHex: string }) =>
			signInHeadSpendNudge({
				...params,
				address,
				network: Network.Preprod,
				encryptedMnemonic: encrypt(TEST_MNEMONIC),
				provider: { fetchProtocolParameters: async () => DEFAULT_PROTOCOL_PARAMETERS } as never,
			}),
		);
		const run = (candidate: { l2ReleaseNudgeTx: string | null } = { l2ReleaseNudgeTx: null }, at = nowMs) =>
			nudgeIdleHeadForRelease({
				hydraHeadId: 'head-1',
				candidate: { id: 'reservation-1', l2ReservationInputRefs: reservedRefs, ...candidate },
				node: node as never,
				provider: provider as never,
				head: (options.noHead ? null : head) as never,
				nowMs: at,
				database: database as never,
				signSpendNudge: signSpendNudge as never,
			});
		return { database, node, provider, head, signSpendNudge, run };
	}

	it('records the signed nudge over the wallet inputs of the body, then sends it', async () => {
		const h = harness();
		await expect(h.run()).resolves.toBe(true);
		expect(h.database.hotWallet.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({ where: { pendingTransactionId: 'reservation-1', deletedAt: null } }),
		);
		expect(h.signSpendNudge).toHaveBeenCalledWith(expect.objectContaining({ inputs: [lockInputA, lockInputB] }));
		const signedTx = await h.signSpendNudge.mock.results[0].value;
		expect(h.database.transaction.updateMany).toHaveBeenCalledWith({
			where: { id: 'reservation-1', status: 'Pending', l2ReleaseNudgeTx: null },
			data: { l2ReleaseNudgeTx: signedTx },
		});
		expect(h.head.newTx).toHaveBeenCalledWith(expect.objectContaining({ cborHex: signedTx }));
		const recordOrder = h.database.transaction.updateMany.mock.invocationCallOrder[0];
		expect(recordOrder).toBeLessThan(h.head.newTx.mock.invocationCallOrder[0]);
	});

	it('gives each nudge a fresh nonce', async () => {
		const h = harness();
		await h.run();
		resetL2ReleaseNudgeThrottle();
		await h.run();
		const [first, second] = h.signSpendNudge.mock.calls.map(([params]) => params.datumHex);
		expect(first).not.toBe(second);
	});

	it('resends the recorded nudge unchanged and never builds a second one', async () => {
		const h = harness();
		await expect(h.run({ l2ReleaseNudgeTx: validNudge })).resolves.toBe(true);
		expect(h.signSpendNudge).not.toHaveBeenCalled();
		expect(h.database.transaction.updateMany).not.toHaveBeenCalled();
		expect(h.head.newTx).toHaveBeenCalledWith(expect.objectContaining({ cborHex: validNudge }));
	});

	it.each([
		['the wallet is not pinned by this reservation', { wallet: false }],
		['a withdrawal is being prepared', { decommit: true }],
		['a decommit is in flight on the node', { pendingDecommits: ['f'.repeat(64)] }],
		['the head session is gone at send time', { noHead: true }],
	] as const)('sends nothing, not even a resend, when %s', async (_label, options) => {
		const h = harness(options);
		await expect(h.run({ l2ReleaseNudgeTx: validNudge })).resolves.toBe(false);
		expect(h.head.newTx).not.toHaveBeenCalled();
	});

	it('sends nothing when another writer recorded a nudge first', async () => {
		const h = harness({ recordedCount: 0 });
		await expect(h.run()).resolves.toBe(false);
		expect(h.head.newTx).not.toHaveBeenCalled();
	});

	// A non-locking action whose body spends only an escrow: no input is the
	// wallet's, so there is nothing to prove with, and the row stays held.
	it('holds when the body has no wallet input left to spend', async () => {
		const h = harness({ utxos: [utxo('c', 0)] });
		await expect(h.run()).resolves.toBe(false);
		expect(h.signSpendNudge).not.toHaveBeenCalled();
		expect(h.database.transaction.updateMany).not.toHaveBeenCalled();
	});

	it('records nothing when the signed nudge would not pass the release proof', async () => {
		const h = harness();
		h.signSpendNudge.mockResolvedValueOnce('not-a-nudge');
		await expect(h.run()).resolves.toBe(false);
		expect(h.database.transaction.updateMany).not.toHaveBeenCalled();
		expect(h.head.newTx).not.toHaveBeenCalled();
	});

	it('nudges a reservation at most once per interval', async () => {
		const h = harness();
		await h.run({ l2ReleaseNudgeTx: validNudge });
		await expect(h.run({ l2ReleaseNudgeTx: validNudge }, nowMs + L2_RELEASE_NUDGE_INTERVAL_MS - 1)).resolves.toBe(
			false,
		);
		await expect(h.run({ l2ReleaseNudgeTx: validNudge }, nowMs + L2_RELEASE_NUDGE_INTERVAL_MS)).resolves.toBe(true);
		expect(h.head.newTx).toHaveBeenCalledTimes(2);
	});

	it('never throws when the head refuses the nudge', async () => {
		const h = harness();
		h.head.newTx.mockRejectedValue(new Error('TxInvalid'));
		await expect(h.run()).resolves.toBe(false);
	});
});
