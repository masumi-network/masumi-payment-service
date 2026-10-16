import { describe, expect, it } from '@jest/globals';
import {
	Address,
	BigNum,
	PlutusData,
	Transaction,
	TransactionBody,
	TransactionHash,
	TransactionInput,
	TransactionInputs,
	TransactionOutput,
	TransactionOutputs,
	TransactionWitnessSet,
	Value,
} from '@emurgo/cardano-serialization-lib-nodejs';
import { serializeHydraSnapshotOutput } from '@/lib/hydra/hydra/snapshot-verification';
import { decideL2ReservationRelease } from './l2-reservation-release-decision';
import {
	encodeL2ReleaseNudgeDatum,
	isL2ReservationSpentByNudge,
	readL2ReleaseNudgeProof,
} from './l2-release-nudge-proof';

const ADDRESS =
	'addr_test1qp6ctf8vcjxzd53et7p0hlqyncn59stnfd4g8mp978v33r6dlzjvt4s2t6wn3v993pu9aea4h3z0jeyn6lsvw6hugtesfx55dd';
const LOCK_INPUT_A = `${'aa'.repeat(32)}#0`;
const LOCK_INPUT_B = `${'bb'.repeat(32)}#1`;
const NONCE = new Uint8Array(32).fill(7);
/** The reservation's own locked funds, from our records. */
const FLOOR = [{ unit: '', amount: 12_000_000n }];

function signedTx(params: { inputs: string[]; outputs: Array<{ lovelace: string; datumHex?: string }> }): string {
	const inputs = TransactionInputs.new();
	for (const reference of params.inputs) {
		const [txHash, index] = reference.split('#');
		inputs.add(TransactionInput.new(TransactionHash.from_hex(txHash), Number(index)));
	}
	const outputs = TransactionOutputs.new();
	for (const output of params.outputs) {
		const txOut = TransactionOutput.new(Address.from_bech32(ADDRESS), Value.new(BigNum.from_str(output.lovelace)));
		if (output.datumHex) txOut.set_plutus_data(PlutusData.from_hex(output.datumHex));
		outputs.add(txOut);
	}
	const body = TransactionBody.new_tx_body(inputs, outputs, BigNum.zero());
	return Transaction.new(body, TransactionWitnessSet.new()).to_hex();
}

function snapshotOutput(lovelace: number, inlineDatumRaw: string | null = null) {
	return {
		address: ADDRESS,
		value: { lovelace },
		referenceScript: null,
		datum: null,
		datumhash: null,
		inlineDatum: null,
		inlineDatumRaw,
		inlineDatumhash: null,
	};
}

const nudgeTx = signedTx({
	inputs: [LOCK_INPUT_A, LOCK_INPUT_B],
	outputs: [{ lovelace: '15000000', datumHex: encodeL2ReleaseNudgeDatum(NONCE) }],
});

describe('l2 release nudge proof', () => {
	it('names the nudge output in the exact bytes a verified snapshot holds for it', () => {
		const proof = readL2ReleaseNudgeProof(nudgeTx, [LOCK_INPUT_A, LOCK_INPUT_B], FLOOR);

		expect(proof).not.toBeNull();
		expect(proof?.reference).toMatch(/^[0-9a-f]{64}#0$/);
		// The snapshot serializes outputs from Hydra JSON, the proof from tx CBOR.
		// They must agree, or the proof could never be found.
		expect(proof?.serializedOutput).toBe(
			serializeHydraSnapshotOutput(snapshotOutput(15_000_000, encodeL2ReleaseNudgeDatum(NONCE))),
		);
	});

	it('refuses a nudge that spends an input the reservation does not', () => {
		const foreign = signedTx({
			inputs: [LOCK_INPUT_A, `${'cc'.repeat(32)}#0`],
			outputs: [{ lovelace: '15000000', datumHex: encodeL2ReleaseNudgeDatum(NONCE) }],
		});

		expect(readL2ReleaseNudgeProof(foreign, [LOCK_INPUT_A, LOCK_INPUT_B], FLOOR)).toBeNull();
	});

	it('refuses a nudge without a nonce datum or with more than one output', () => {
		const untagged = signedTx({ inputs: [LOCK_INPUT_A], outputs: [{ lovelace: '10000000' }] });
		const otherDatum = signedTx({ inputs: [LOCK_INPUT_A], outputs: [{ lovelace: '10000000', datumHex: 'd87980' }] });
		const split = signedTx({
			inputs: [LOCK_INPUT_A],
			outputs: [{ lovelace: '5000000', datumHex: encodeL2ReleaseNudgeDatum(NONCE) }, { lovelace: '5000000' }],
		});

		for (const tx of [untagged, otherDatum, split, 'not-cbor']) {
			expect(readL2ReleaseNudgeProof(tx, [LOCK_INPUT_A], [{ unit: '', amount: 1n }])).toBeNull();
		}
	});

	it('proves the reservation dead only once the nudge output bytes are in the snapshot', () => {
		const proof = readL2ReleaseNudgeProof(nudgeTx, [LOCK_INPUT_A, LOCK_INPUT_B], FLOOR);
		if (!proof) throw new Error('expected a proof');
		const inputRefs = [LOCK_INPUT_A, LOCK_INPUT_B];

		expect(
			isL2ReservationSpentByNudge({
				nudgeTx: null,
				inputRefs,
				valueFloor: FLOOR,
				readOutput: () => proof.serializedOutput,
			}),
		).toBe(false);
		// Not applied yet, or rejected because the body spent the inputs first.
		expect(isL2ReservationSpentByNudge({ nudgeTx, inputRefs, valueFloor: FLOOR, readOutput: () => null })).toBe(false);
		expect(
			isL2ReservationSpentByNudge({
				nudgeTx,
				inputRefs,
				valueFloor: FLOOR,
				readOutput: (reference) => (reference === proof.reference ? proof.serializedOutput : null),
			}),
		).toBe(true);
		// A node that maps the nudge reference onto other bytes proves nothing.
		const other = serializeHydraSnapshotOutput(snapshotOutput(15_000_000));
		expect(isL2ReservationSpentByNudge({ nudgeTx, inputRefs, valueFloor: FLOOR, readOutput: () => other })).toBe(false);
	});

	// The reported finding: a local node maps the body's input references onto
	// identical outputs that still exist, here two 5 ADA collateral twins, while
	// the real inputs are spent. Every signature stays valid. The reference
	// proof accepts that. The nudge proof needs bytes only our nudge creates.
	it('does not release on twin outputs mapped under spent input references', () => {
		const twin = serializeHydraSnapshotOutput(snapshotOutput(5_000_000));
		const forgedRead = (reference: string) => (reference === LOCK_INPUT_A || reference === LOCK_INPUT_B ? twin : null);

		expect(
			decideL2ReservationRelease({
				inputRefs: [LOCK_INPUT_A, LOCK_INPUT_B],
				snapshotNumber: 11n,
				baselineSnapshotNumber: 10n,
				nudgeInputRef: null,
				readVerifiedOutput: forgedRead,
			}),
		).toEqual({ action: 'release' });
		expect(
			isL2ReservationSpentByNudge({
				nudgeTx,
				inputRefs: [LOCK_INPUT_A, LOCK_INPUT_B],
				valueFloor: FLOOR,
				readOutput: forgedRead,
			}),
		).toBe(false);
	});

	// The review's attack: a compromised node hides the large input, so the
	// nudge would spend only the small one, and a copy of its output is cheap.
	it('refuses a nudge that spends only some of the body inputs', () => {
		const subset = signedTx({
			inputs: [LOCK_INPUT_B],
			outputs: [{ lovelace: '15000000', datumHex: encodeL2ReleaseNudgeDatum(NONCE) }],
		});

		expect(readL2ReleaseNudgeProof(subset, [LOCK_INPUT_A, LOCK_INPUT_B], FLOOR)).toBeNull();
	});

	// The node reports input values, so it can make the nudge output small. The
	// floor from our own records makes a copy cost at least the locked funds.
	it('refuses a nudge output below the value floor', () => {
		const small = signedTx({
			inputs: [LOCK_INPUT_A, LOCK_INPUT_B],
			outputs: [{ lovelace: '11999999', datumHex: encodeL2ReleaseNudgeDatum(NONCE) }],
		});

		expect(readL2ReleaseNudgeProof(small, [LOCK_INPUT_A, LOCK_INPUT_B], FLOOR)).toBeNull();
		expect(
			readL2ReleaseNudgeProof(small, [LOCK_INPUT_A, LOCK_INPUT_B], [{ unit: 'lovelace', amount: 11_999_999n }]),
		).not.toBeNull();
	});

	it('sums repeated floor units and requires every unit', () => {
		const inputs = [LOCK_INPUT_A, LOCK_INPUT_B];
		expect(
			readL2ReleaseNudgeProof(nudgeTx, inputs, [
				{ unit: '', amount: 10_000_000n },
				{ unit: 'lovelace', amount: 5_000_001n },
			]),
		).toBeNull();
		expect(readL2ReleaseNudgeProof(nudgeTx, inputs, [...FLOOR, { unit: 'ab'.repeat(28), amount: 1n }])).toBeNull();
	});

	it('proves nothing with an empty or zero floor', () => {
		const inputs = [LOCK_INPUT_A, LOCK_INPUT_B];
		expect(readL2ReleaseNudgeProof(nudgeTx, inputs, [])).toBeNull();
		expect(readL2ReleaseNudgeProof(nudgeTx, inputs, [{ unit: '', amount: 0n }])).toBeNull();
		expect(isL2ReservationSpentByNudge({ nudgeTx, inputRefs: inputs, valueFloor: null, readOutput: () => 'x' })).toBe(
			false,
		);
	});

	it('rejects a nonce of the wrong length', () => {
		expect(() => encodeL2ReleaseNudgeDatum(new Uint8Array(31))).toThrow();
	});
});
