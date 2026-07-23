import { describe, expect, it } from '@jest/globals';
import {
	Address,
	BigNum,
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
import { resolveTxHash } from '@meshsdk/core';

import {
	deriveHydraVerificationKeyCborHex,
	computeHydraAccumulatorHash,
	doesHydraTransactionTransitionReachSnapshot,
	hydraSnapshotSignableBytes,
	resolveVerifiedHydraFanoutReference,
	serializeHydraSnapshotOutput,
	verifyHydraSnapshot,
	type HydraSnapshotVerificationFrame,
} from './snapshot-verification';
import { HydraTransactionType } from './types';

const ADDRESS =
	'addr_test1qp6ctf8vcjxzd53et7p0hlqyncn59stnfd4g8mp978v33r6dlzjvt4s2t6wn3v993pu9aea4h3z0jeyn6lsvw6hugtesfx55dd';
const HEAD_ID = '22cc3e117a6e471dd7a34cfa8d0ae7ba057068ddf01c44a97513ec03';
const PARTY_KEYS = [
	'f760bf7abf2a44f175500c235faca2ac4fc98a9844f121c1e513731d3e745ade',
	'36c8df202f87702c50ed810a32b12401f7e551bdf5eea711aa57fc418748e7fb',
];

function output(value: Record<string, number | Record<string, number>>) {
	return {
		address: ADDRESS,
		value,
		referenceScript: null,
		datumhash: null,
		inlineDatum: null,
		inlineDatumRaw: null,
		datum: null,
	};
}

function realHydra230SnapshotOne(): HydraSnapshotVerificationFrame {
	return {
		headId: HEAD_ID,
		signatures: {
			multiSignature: [
				'4b1a8963e2f2998d7447a78f9e46778fa5fe62c9c870469631ffefcc1b14727634ab6c02d04b69cea0ff48dfcc26d800dc58643e173f636f3a9eb0da0298a70d',
				'5275d14ca66c335dadd3448437faca02a00f948b1cab1efd13c5e99e7daa2d093536f52c6f9789af5f855b8ad1833dea4db3146aef74c7d9aa93799343042900',
			],
		},
		snapshot: {
			headId: HEAD_ID,
			version: 0,
			number: 1,
			accumulator: '8c2e1a3ed6f465e5267989a24310b6d4f31fa805e6bede11d9afd60ca0cf7e42',
			confirmed: [],
			utxo: {},
			utxoToCommit: {
				'a6fcca277c6ff7595131b6112b1ec6ccbff8a16b8c5db1e1a86b4fa7ccd23ab4#1': output({
					lovelace: 5_000_000,
				}),
				'a6fcca277c6ff7595131b6112b1ec6ccbff8a16b8c5db1e1a86b4fa7ccd23ab4#2': output({
					lovelace: 968_522_530,
					'16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde': {
						'0014df10745553444d': 1_000_000_000,
					},
				}),
				'f82cffc811eceac62b66b6151074369e4eeab0a219796e5ef41191cfe91f0d59#1': output({
					lovelace: 5_000_000,
				}),
			},
			utxoToDecommit: null,
		},
	};
}

describe('Hydra 2.3 snapshot verification', () => {
	it('recomputes the real accumulator and verifies ordered party signatures', () => {
		const frame = realHydra230SnapshotOne();
		const verified = verifyHydraSnapshot(frame, PARTY_KEYS);

		expect(verified.number).toBe(1);
		expect(verified.outputs.size).toBe(3);
		expect(hydraSnapshotSignableBytes(frame).toString('hex')).toContain(
			'58204675209cc40bd9df9188ed214c4679c5be233f560c57ea93e07e27553bc7de7c',
		);
	});

	it('matches Hydra canonical Plutus TxOut serialization', () => {
		const serialized = serializeHydraSnapshotOutput(output({ lovelace: 5_000_000 }));
		expect(serialized).toBe(
			'd8799fd8799fd8799f581c7585a4ecc48c26d2395f82fbfc049e2742c1734b6a83ec25f1d9188fffd8799fd8799fd8799f581c4df8a4c5d60a5e9d38b0a588785ee7b5bc44f96493d7e0c76afc42f3ffffffffa140a1401a004c4b40d87980d87a80ff',
		);
	});

	it('matches an independently generated 64-output accumulator vector through the NTT path', () => {
		const serialized = serializeHydraSnapshotOutput(output({ lovelace: 5_000_000 }));
		expect(computeHydraAccumulatorHash(Array(64).fill(serialized))).toBe(
			'400ffaa34dca37f1fa5e6fa7e76b63087d071867c6ccffae8b37f24d75cd0402',
		);
	});

	it('fails closed for accumulator, state, signature, and party-order changes', () => {
		const badAccumulator = realHydra230SnapshotOne();
		badAccumulator.snapshot.accumulator = '00'.repeat(32);
		expect(() => verifyHydraSnapshot(badAccumulator, PARTY_KEYS)).toThrow(/signature/);

		const badState = realHydra230SnapshotOne();
		badState.snapshot.utxoToCommit![
			'a6fcca277c6ff7595131b6112b1ec6ccbff8a16b8c5db1e1a86b4fa7ccd23ab4#1'
		]!.value.lovelace = 5_000_001;
		expect(() => verifyHydraSnapshot(badState, PARTY_KEYS)).toThrow(/signature/);

		const badSettledState = realHydra230SnapshotOne();
		badSettledState.snapshot.utxo[`${'33'.repeat(32)}#0`] = output({ lovelace: 5_000_000 });
		expect(() => verifyHydraSnapshot(badSettledState, PARTY_KEYS)).toThrow(/accumulator/);

		const badSignature = realHydra230SnapshotOne();
		badSignature.signatures.multiSignature[0] = '00'.repeat(64);
		expect(() => verifyHydraSnapshot(badSignature, PARTY_KEYS)).toThrow(/signature/);

		expect(() => verifyHydraSnapshot(realHydra230SnapshotOne(), [...PARTY_KEYS].reverse())).toThrow(/signature/);
	});

	it('rejects unauthenticated state before expensive accumulator work', () => {
		const frame = realHydra230SnapshotOne();
		frame.signatures.multiSignature[0] = '00'.repeat(64);
		frame.snapshot.accumulator = '00'.repeat(32);

		expect(() => verifyHydraSnapshot(frame, PARTY_KEYS)).toThrow(/signature/);
	});

	it('rejects case-variant output references across signed state partitions', () => {
		const frame = realHydra230SnapshotOne();
		const reference = 'a6fcca277c6ff7595131b6112b1ec6ccbff8a16b8c5db1e1a86b4fa7ccd23ab4#1';
		frame.snapshot.utxo[reference.toUpperCase()] = frame.snapshot.utxoToCommit![reference]!;

		expect(() => verifyHydraSnapshot(frame, PARTY_KEYS)).toThrow(/repeated one output reference/);
	});

	it('derives the verification key from a Hydra text-envelope signing seed', () => {
		expect(
			deriveHydraVerificationKeyCborHex(
				JSON.stringify({
					type: 'HydraSigningKey_ed25519',
					cborHex: '5820903bdcddb67107f5c5df25c4a6b0b94f28717fe497157e5a14815e8146c2fbcc',
				}),
			),
		).toBe('5820f760bf7abf2a44f175500c235faca2ac4fc98a9844f121c1e513731d3e745ade');
	});

	it('checks signed multiset deltas without trusting adversarial reference mappings', () => {
		const priorReference = `${'11'.repeat(32)}#0`;
		const otherReference = `${'22'.repeat(32)}#0`;
		const priorOutput = serializeHydraSnapshotOutput(output({ lovelace: 7_000_000 }));
		const otherOutput = serializeHydraSnapshotOutput(output({ lovelace: 8_000_000 }));
		const nextOutput = serializeHydraSnapshotOutput(output({ lovelace: 6_000_000 }));

		const inputs = TransactionInputs.new();
		inputs.add(TransactionInput.new(TransactionHash.from_bytes(Buffer.from('11'.repeat(32), 'hex')), 0));
		const outputs = TransactionOutputs.new();
		outputs.add(TransactionOutput.new(Address.from_bech32(ADDRESS), Value.new(BigNum.from_str('6000000'))));
		const body = TransactionBody.new_tx_body(inputs, outputs, BigNum.from_str('1000000'));
		const transaction = Transaction.new(body, TransactionWitnessSet.new());
		const cborHex = Buffer.from(transaction.to_bytes()).toString('hex');
		const txId = String(resolveTxHash(cborHex)).toLowerCase();
		const confirmed = [{ type: HydraTransactionType.TxConwayEra, cborHex, description: '', txId }];
		const outputMultiset = (values: string[]) => {
			const multiset = new Map<string, number>();
			for (const value of values) multiset.set(value, (multiset.get(value) ?? 0) + 1);
			return multiset;
		};
		const current = {
			headId: HEAD_ID,
			number: 2,
			version: 1,
			outputs: new Map([
				[otherReference, otherOutput],
				[`${txId}#0`, nextOutput],
			]),
			outputMultiset: outputMultiset([otherOutput, nextOutput]),
		};
		const honestMapping = {
			headId: HEAD_ID,
			number: 1,
			version: 0,
			outputs: new Map([
				[priorReference, priorOutput],
				[otherReference, otherOutput],
			]),
			outputMultiset: outputMultiset([priorOutput, otherOutput]),
		};
		const permutedMapping = {
			...honestMapping,
			outputs: new Map([
				[priorReference, otherOutput],
				[otherReference, priorOutput],
			]),
		};

		expect(doesHydraTransactionTransitionReachSnapshot(honestMapping, current, confirmed)).toBe(true);
		expect(doesHydraTransactionTransitionReachSnapshot(permutedMapping, current, confirmed)).toBe(true);
	});

	it('maps a unique producer-CBOR output to its exact observed L1 fanout reference', () => {
		const hydraReference = `${'11'.repeat(32)}#3`;
		const fanoutReference = `${'22'.repeat(32)}#7`;
		const serializedOutput = serializeHydraSnapshotOutput(output({ lovelace: 7_000_000 }));
		const snapshot = {
			headId: HEAD_ID,
			number: 9,
			version: 0,
			outputs: new Map([[hydraReference, serializedOutput]]),
			outputMultiset: new Map([[serializedOutput, 1]]),
		};

		expect(
			resolveVerifiedHydraFanoutReference(snapshot, new Map([[fanoutReference, serializedOutput]]), serializedOutput),
		).toEqual({
			txHash: '22'.repeat(32),
			outputIndex: 7,
			snapshotNumber: 9,
			serializedOutput,
		});
	});

	it('ignores an endpoint-permuted unsigned snapshot reference map', () => {
		const firstHydraReference = `${'11'.repeat(32)}#0`;
		const secondHydraReference = `${'12'.repeat(32)}#0`;
		const firstFanoutReference = `${'22'.repeat(32)}#0`;
		const secondFanoutReference = `${'22'.repeat(32)}#1`;
		const firstOutput = serializeHydraSnapshotOutput(output({ lovelace: 7_000_000 }));
		const secondOutput = serializeHydraSnapshotOutput(output({ lovelace: 8_000_000 }));
		const snapshot = {
			headId: HEAD_ID,
			number: 9,
			version: 0,
			// References are not signed. Deliberately attach each value to the
			// other producer while retaining the authentic signed multiset.
			outputs: new Map([
				[firstHydraReference, secondOutput],
				[secondHydraReference, firstOutput],
			]),
			outputMultiset: new Map([
				[firstOutput, 1],
				[secondOutput, 1],
			]),
		};
		const fanoutOutputs = new Map([
			[firstFanoutReference, firstOutput],
			[secondFanoutReference, secondOutput],
		]);

		expect(resolveVerifiedHydraFanoutReference(snapshot, fanoutOutputs, firstOutput)).toEqual({
			txHash: '22'.repeat(32),
			outputIndex: 0,
			snapshotNumber: 9,
			serializedOutput: firstOutput,
		});
	});

	it('rejects incomplete, changed, or duplicate fanout output mappings', () => {
		const hydraReference = `${'11'.repeat(32)}#0`;
		const serializedOutput = serializeHydraSnapshotOutput(output({ lovelace: 7_000_000 }));
		const otherOutput = serializeHydraSnapshotOutput(output({ lovelace: 8_000_000 }));
		const snapshot = {
			headId: HEAD_ID,
			number: 9,
			version: 0,
			outputs: new Map([
				[hydraReference, serializedOutput],
				[`${'12'.repeat(32)}#0`, otherOutput],
			]),
			outputMultiset: new Map([
				[serializedOutput, 1],
				[otherOutput, 1],
			]),
		};

		expect(
			resolveVerifiedHydraFanoutReference(
				snapshot,
				new Map([[`${'22'.repeat(32)}#0`, serializedOutput]]),
				serializedOutput,
			),
		).toBeNull();
		expect(
			resolveVerifiedHydraFanoutReference(
				{
					...snapshot,
					outputs: new Map([
						[hydraReference, serializedOutput],
						[`${'12'.repeat(32)}#0`, serializedOutput],
					]),
					outputMultiset: new Map([[serializedOutput, 2]]),
				},
				new Map([
					[`${'22'.repeat(32)}#0`, serializedOutput],
					[`${'22'.repeat(32)}#1`, serializedOutput],
				]),
				serializedOutput,
			),
		).toBeNull();
	});
});
