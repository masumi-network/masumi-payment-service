import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { FixedTransaction, PrivateKey } from '@emurgo/cardano-serialization-lib-nodejs';
import { DEFAULT_PROTOCOL_PARAMETERS, MeshWallet, type UTxO } from '@meshsdk/core';
import { logger } from '@masumi/payment-core/logger';
import { Network } from '@/generated/prisma/client';
import { encrypt } from '@/utils/security/encryption';
import { readHydraSignedTransactionShape } from '@/lib/hydra/hydra/signed-transaction-shape';
import { PENDING_STALE_AFTER_MS, PREPARING_STALE_AFTER_MS } from '@/services/hydra-decommit/stale';
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
const reservedRefs = [toUtxoRef(lockInputA), toUtxoRef(lockInputB)];
const valueFloor = [{ unit: '', amount: 8_000_000n }];

/** The same nudge with `count` more vkey witnesses: the body, and so the release proof, is unchanged. */
function withExtraWitnesses(signedTx: string, count: number): string {
	const transaction = FixedTransaction.from_hex(signedTx);
	for (let index = 0; index < count; index += 1) {
		transaction.sign_and_add_vkey_signature(PrivateKey.generate_ed25519());
	}
	return transaction.to_hex();
}

describe('selectReleaseNudgeInputs', () => {
	const select = (utxos: UTxO[], options: { pendingIncrementRefs?: Set<string> } = {}) =>
		selectReleaseNudgeInputs({
			utxos,
			address,
			reservedRefs,
			pendingIncrementRefs: options.pendingIncrementRefs ?? new Set(),
		});

	it('takes every input of the body, lowest reference first, and nothing else', () => {
		expect(select([lockInputB, utxo('c', 0), lockInputA])?.map(toUtxoRef)).toEqual([
			toUtxoRef(lockInputA),
			toUtxoRef(lockInputB),
		]);
	});

	// A compromised node can hide an input to steer the nudge onto a cheap
	// subset. A missing input holds the row rather than shrinking the nudge.
	it('holds when any body input is missing from the wallet UTxOs', () => {
		expect(select([lockInputB])).toBeNull();
	});

	it.each([
		['a reference script', { scriptRef: '82' }],
		['another address', { address: 'addr_test1other' }],
	] as const)('holds when a body input has %s', (_label, overrides) => {
		expect(select([{ ...lockInputA, output: { ...lockInputA.output, ...overrides } }, lockInputB])).toBeNull();
	});

	it('holds when a body input is a pending increment', () => {
		expect(select([lockInputA, lockInputB], { pendingIncrementRefs: new Set([toUtxoRef(lockInputA)]) })).toBeNull();
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
		expect(readL2ReleaseNudgeProof(signedTx, reservedRefs, valueFloor)).not.toBeNull();
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
			/** A withdrawal row this old, in ms, with this status. */
			staleDecommit?: { status: 'Preparing' | 'Pending'; ageMs: number };
			/** The node's `GET /head` reply, or an Error it throws. */
			headState?: unknown;
			/** Null: the node could not be asked. */
			pendingDecommits?: readonly string[] | null;
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
			hydraDecommit: {
				findMany: jest.fn(async () => {
					if (options.staleDecommit) {
						const at = new Date(nowMs - options.staleDecommit.ageMs);
						return [{ status: options.staleDecommit.status, createdAt: at, updatedAt: at }];
					}
					return options.decommit
						? [{ status: 'Preparing', createdAt: new Date(nowMs), updatedAt: new Date(nowMs) }]
						: [];
				}),
			},
			transaction: { updateMany: jest.fn(async (_args: unknown) => ({ count: options.recordedCount ?? 1 })) },
		};
		const node = {
			verifiedSnapshotNumber: 7n as bigint | undefined,
			pendingIncrementUtxoRefs: new Set<string>(),
			fetchPendingDecommitRefs: jest.fn(async () =>
				options.pendingDecommits === null ? undefined : [...(options.pendingDecommits ?? [])],
			),
			get: jest.fn(async (_url: string) => {
				if (options.headState instanceof Error) throw options.headState;
				return options.headState;
			}),
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
				candidate: { id: 'reservation-1', l2ReservationInputRefs: reservedRefs, valueFloor, ...candidate },
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

	// Recorded before the 15,000-byte L2 limit: the send check would refuse it
	// at every interval, and a second nudge must never be built.
	it('holds a recorded nudge above the L2 limit instead of resending it', async () => {
		const h = harness();
		await expect(h.run({ l2ReleaseNudgeTx: '00'.repeat(15_001) })).resolves.toBe(false);
		expect(h.head.newTx).not.toHaveBeenCalled();
		expect(h.signSpendNudge).not.toHaveBeenCalled();
	});

	it.each([
		['the wallet is not pinned by this reservation', { wallet: false }],
		['a withdrawal is being prepared', { decommit: true }],
		['a decommit is in flight on the node', { pendingDecommits: ['f'.repeat(64)] }],
		['the node cannot say whether a decommit is in flight', { pendingDecommits: null }],
		['the head session is gone at send time', { noHead: true }],
	] as const)('sends nothing, not even a resend, when %s', async (_label, options) => {
		const h = harness(options);
		await expect(h.run({ l2ReleaseNudgeTx: validNudge })).resolves.toBe(false);
		expect(h.head.newTx).not.toHaveBeenCalled();
	});

	describe('an abandoned withdrawal row', () => {
		const nodeHoldsNoWithdrawal = { contents: { coordinatedHeadState: { decommitTx: null } } };
		const nodeHoldsWithdrawal = { contents: { coordinatedHeadState: { decommitTx: { txId: 'd'.repeat(64) } } } };
		const staleAgeMs = 2 * PENDING_STALE_AFTER_MS;

		it.each([
			['a crash left it Preparing', { status: 'Preparing', ageMs: PREPARING_STALE_AFTER_MS + 1 }],
			['an ambiguous answer left it Pending', { status: 'Pending', ageMs: staleAgeMs }],
		] as const)('no longer blocks once %s and the node holds no withdrawal', async (_label, staleDecommit) => {
			const h = harness({ staleDecommit, headState: nodeHoldsNoWithdrawal });
			await expect(h.run({ l2ReleaseNudgeTx: validNudge })).resolves.toBe(true);
			expect(h.node.get).toHaveBeenCalledWith('/head');
			expect(h.head.newTx).toHaveBeenCalled();
		});

		it.each([
			['the node still holds a withdrawal', nodeHoldsWithdrawal],
			['the node cannot be read', new Error('502 Bad Gateway')],
			['the node reply has an unknown shape', { contents: { coordinatedHeadState: {} } }],
		])('still blocks when %s', async (_label, headState) => {
			const h = harness({ staleDecommit: { status: 'Pending', ageMs: staleAgeMs }, headState });
			await expect(h.run({ l2ReleaseNudgeTx: validNudge })).resolves.toBe(false);
			expect(h.head.newTx).not.toHaveBeenCalled();
		});

		it('still blocks a Pending row younger than the age limit, without asking the node', async () => {
			const h = harness({
				staleDecommit: { status: 'Pending', ageMs: PENDING_STALE_AFTER_MS - 1 },
				headState: nodeHoldsNoWithdrawal,
			});
			await expect(h.run({ l2ReleaseNudgeTx: validNudge })).resolves.toBe(false);
			expect(h.node.get).not.toHaveBeenCalled();
		});
	});

	it('sends nothing when another writer recorded a nudge first', async () => {
		const h = harness({ recordedCount: 0 });
		await expect(h.run()).resolves.toBe(false);
		expect(h.head.newTx).not.toHaveBeenCalled();
	});

	// A non-locking action whose body spends an escrow: that input is not the
	// wallet's, so there is nothing to prove with, and the row stays held.
	it('holds when not every body input is a wallet UTxO', async () => {
		const h = harness({ utxos: [lockInputA, utxo('c', 0)] });
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

	// Only a row with no nudge recorded takes one, so recording an oversized
	// nudge would block every smaller one for good.
	it('records nothing when the signed nudge is above the L2 limit', async () => {
		const h = harness();
		const sign = h.signSpendNudge.getMockImplementation();
		h.signSpendNudge.mockImplementationOnce(async (params) => withExtraWitnesses(await sign!(params), 160));

		await expect(h.run()).resolves.toBe(false);
		const signedTx = (await h.signSpendNudge.mock.results[0].value) as string;
		expect(signedTx.length / 2).toBeGreaterThan(15_000);
		expect(readL2ReleaseNudgeProof(signedTx, reservedRefs, valueFloor)).not.toBeNull();
		expect(h.database.transaction.updateMany).not.toHaveBeenCalled();
		expect(h.head.newTx).not.toHaveBeenCalled();
	});

	// The node reports input values. Under-reported values make the nudge
	// output fall below the floor, so nothing is recorded or sent.
	it('records nothing when the node under-reports the input values', async () => {
		const h = harness({
			utxos: [
				{ ...lockInputA, output: { ...lockInputA.output, amount: [{ unit: 'lovelace', quantity: '1000000' }] } },
				lockInputB,
			],
		});
		await expect(h.run()).resolves.toBe(false);
		expect(h.signSpendNudge).toHaveBeenCalledTimes(1);
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
