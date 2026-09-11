import { readFileSync } from 'node:fs';
import path from 'node:path';
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
import { createHash, createPrivateKey, createPublicKey, sign as signEd25519 } from 'node:crypto';

import { HydraProtocolError } from './errors';
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

// Self-signed parties for tests that must survive a formula change: unlike
// `PARTY_KEYS` above (verification keys for a real Hydra node's signature —
// we hold no matching private key, only the derived public one), these are
// generated locally and signed at run time over whatever
// `hydraSnapshotSignableBytes` currently produces, exactly as
// `node.spec.ts`'s `signedSnapshotFrame` does. That keeps a test's SIGNATURE
// verifying regardless of which commit-slot formula is current, so tests that
// exercise ordering or structural checks *after* the signature gate don't
// need a real recorded fixture at all.
const ED25519_PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function selfSignedParty(seedByte: number) {
	const privateKey = createPrivateKey({
		key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, Buffer.alloc(32, seedByte)]),
		format: 'der',
		type: 'pkcs8',
	});
	const rawVerificationKey = Buffer.from(createPublicKey(privateKey).export({ format: 'der', type: 'spki' }))
		.subarray(-32)
		.toString('hex');
	return { privateKey, rawVerificationKey };
}

const SELF_SIGNED_PARTIES = [selfSignedParty(1), selfSignedParty(2)];
const SELF_SIGNED_KEYS = SELF_SIGNED_PARTIES.map(({ rawVerificationKey }) => rawVerificationKey);

/** Sign `frame` for `SELF_SIGNED_KEYS` under whatever formula is current. */
function selfSign(frame: HydraSnapshotVerificationFrame): HydraSnapshotVerificationFrame {
	const signableBytes = hydraSnapshotSignableBytes(frame);
	return {
		...frame,
		signatures: {
			multiSignature: SELF_SIGNED_PARTIES.map(({ privateKey }) =>
				signEd25519(null, signableBytes, privateKey).toString('hex'),
			),
		},
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
	// The signature half of this vector is 2.3-signed and can no longer verify
	// under the 2.4 formula (see the 2.4.1 recording below for the signed
	// cases); what survives is the formula-only byte assertion that follows.

	// Formula-only assertion — verifyHydraSnapshot/signatures are not involved,
	// so this needs no 2.4.1 recording. This is the only REAL (non-empty)
	// utxoToCommit vector in the file: it independently confirms the outer
	// sha256 wraps the genuine bare commit hash 4675209c… (the exact value the
	// pre-2.4 formula produced for this vector), not a hash built from an
	// empty or placeholder input.
	it('re-hashes a real non-empty utxoToCommit through the 2.4 formula', () => {
		expect(hydraSnapshotSignableBytes(realHydra230SnapshotOne()).toString('hex')).toContain(
			'5820390418a3d92aba540d7ad7817c0642a308e38c2e128db39daf351fd35b4a6a33',
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

	// Rebuilt on a self-signed frame rather than `realHydra230SnapshotOne()`:
	// under the 2.4 formula every frame derived from that helper already fails
	// signature verification regardless of what else is mutated (its signature
	// was made over the 2.3 formula), which made this test vacuous — it kept
	// passing for a reason unrelated to the ordering property it exists to
	// pin. A self-signed frame's signature tracks whatever formula is current,
	// so mutating it to garbage here is what actually drives the assertion.
	it('rejects unauthenticated state before expensive accumulator work', () => {
		const reference = `${'33'.repeat(32)}#0`;
		const committed = output({ lovelace: 5_000_000 });
		const frame: HydraSnapshotVerificationFrame = {
			headId: HEAD_ID,
			signatures: { multiSignature: [] },
			snapshot: {
				headId: HEAD_ID,
				version: 0,
				number: 1,
				accumulator: computeHydraAccumulatorHash([serializeHydraSnapshotOutput(committed)]),
				confirmed: [],
				utxo: {},
				utxoToCommit: { [reference]: committed },
				utxoToDecommit: null,
			},
		};
		const signed = selfSign(frame);
		signed.signatures.multiSignature[0] = '00'.repeat(64);
		signed.snapshot.accumulator = '00'.repeat(32);

		expect(() => verifyHydraSnapshot(signed, SELF_SIGNED_KEYS)).toThrow(/signature/);
	});

	// Rebuilt on a self-signed frame: this is a formula-independent security
	// guard (two partitions naming the same UTxO reference under different hex
	// casing), unrelated to the commit-slot formula, so it needs no 2.4.1
	// recording and should not stay dark until one exists.
	it('rejects case-variant output references across signed state partitions', () => {
		const reference = `${'44'.repeat(32)}#0`;
		const committed = output({ lovelace: 5_000_000 });
		const frame: HydraSnapshotVerificationFrame = {
			headId: HEAD_ID,
			signatures: { multiSignature: [] },
			snapshot: {
				headId: HEAD_ID,
				version: 0,
				number: 1,
				accumulator: computeHydraAccumulatorHash([serializeHydraSnapshotOutput(committed)]),
				confirmed: [],
				utxo: {},
				utxoToCommit: { [reference]: committed },
				utxoToDecommit: null,
			},
		};
		const signed = selfSign(frame);
		// Mutating `utxo` after signing does not change the signable bytes — only
		// the already-computed `accumulator` is signed, not `utxo` itself — so
		// the signature above still verifies and execution reaches
		// `canonicalSnapshotOutputs`, which must still refuse the same reference
		// appearing in two partitions under different casing.
		signed.snapshot.utxo[reference.toUpperCase()] = committed;

		expect(() => verifyHydraSnapshot(signed, SELF_SIGNED_KEYS)).toThrow(/repeated one output reference/);
	});

	// The three checks below were bundled into the quarantined
	// 'fails closed for accumulator, state, signature, and party-order changes'
	// test above, which verifies a REAL recorded 2.3 multisignature and so cannot
	// run under the 2.4 formula. Only the garbage-signature assertion of that
	// bundle is covered elsewhere; these three were left with no active coverage
	// at all, including `verifyHydraSnapshot`'s accumulator-conservation check and
	// its ordered per-index party verification. None of them needs a recorded
	// fixture — they are structural checks that run *after* the signature gate, so
	// a self-signed frame reaches them under whatever formula is current.
	function selfSignedFrameWith(utxo: Record<string, ReturnType<typeof output>>): HydraSnapshotVerificationFrame {
		return selfSign({
			headId: HEAD_ID,
			signatures: { multiSignature: [] },
			snapshot: {
				headId: HEAD_ID,
				version: 0,
				number: 1,
				accumulator: computeHydraAccumulatorHash(
					Object.values(utxo).map((entry) => serializeHydraSnapshotOutput(entry)),
				),
				confirmed: [],
				utxo,
				utxoToCommit: null,
				utxoToDecommit: null,
			},
		});
	}

	it('refuses a snapshot whose signed accumulator does not commit to its own outputs', () => {
		const signed = selfSignedFrameWith({ [`${'55'.repeat(32)}#0`]: output({ lovelace: 5_000_000 }) });
		// Added after signing, so the signature still verifies and the accumulator
		// is the only thing that can catch it — which is the property under test:
		// a party cannot smuggle an output past a correctly signed snapshot.
		signed.snapshot.utxo[`${'66'.repeat(32)}#0`] = output({ lovelace: 1_000_000 });

		expect(() => verifyHydraSnapshot(signed, SELF_SIGNED_KEYS)).toThrow(/accumulator/);
	});

	it('refuses a snapshot whose output value was altered after signing', () => {
		const reference = `${'77'.repeat(32)}#0`;
		const signed = selfSignedFrameWith({ [reference]: output({ lovelace: 5_000_000 }) });
		signed.snapshot.utxo[reference]!.value.lovelace = 5_000_001;

		expect(() => verifyHydraSnapshot(signed, SELF_SIGNED_KEYS)).toThrow(/accumulator/);
	});

	it('refuses a valid multisignature presented in the wrong party order', () => {
		const signed = selfSignedFrameWith({ [`${'88'.repeat(32)}#0`]: output({ lovelace: 5_000_000 }) });
		// Every signature is genuine; only the party order is reversed. Signatures
		// are verified per index against the bound order, so this must still fail —
		// otherwise a re-ordered multisignature would authenticate.
		expect(() => verifyHydraSnapshot(signed, [...SELF_SIGNED_KEYS].reverse())).toThrow(/signature/);
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

	// A pending decommit and a pending deposit are different outputs, and their
	// serialized values are identical whenever a withdrawal and a top-up of the
	// same size go to the same wallet — the ordinary shape here. Both left on
	// this transition, so both are allowed; what makes that safe is that the
	// allowance is derived per reference, so it is granted only to the exact
	// entries that are gone from `current`.
	//
	// Getting this wrong in the strict direction is the expensive one: history
	// replays from the beginning on every reconnect, so a frame rejected once is
	// rejected forever — the head never gets a verified session again and every
	// L2 escrow operation on it fails closed.
	it('lets a decommit and a recovered deposit of the same value leave together', () => {
		const decommitReference = `${'33'.repeat(32)}#0`;
		const depositReference = `${'44'.repeat(32)}#0`;
		// Identical bytes, two different outputs: same address, same amount, no
		// datum and no reference script.
		const sharedOutput = serializeHydraSnapshotOutput(output({ lovelace: 10_000_000 }));
		const keptOutput = serializeHydraSnapshotOutput(output({ lovelace: 4_000_000 }));
		const keptReference = `${'55'.repeat(32)}#0`;

		const previous = {
			headId: HEAD_ID,
			number: 4,
			version: 2,
			outputs: new Map([
				[keptReference, keptOutput],
				[decommitReference, sharedOutput],
				[depositReference, sharedOutput],
			]),
			outputMultiset: new Map([
				[keptOutput, 1],
				[sharedOutput, 2],
			]),
			committedOutputs: new Map([[depositReference, sharedOutput]]),
			decommitOutputs: new Map([[decommitReference, sharedOutput]]),
		};
		// The decommit settles on L1 and the deposit passes its deadline and is
		// recovered, both without a transaction inside the head.
		const current = {
			headId: HEAD_ID,
			number: 5,
			version: 3,
			outputs: new Map([[keptReference, keptOutput]]),
			outputMultiset: new Map([[keptOutput, 1]]),
			committedOutputs: new Map<string, string>(),
			decommitOutputs: new Map<string, string>(),
		};

		expect(doesHydraTransactionTransitionReachSnapshot(previous, current, [])).toBe(true);
	});

	// The same collision, seen from the other side. A deposit that a transaction
	// spent must not also count as recovered, or the removal is paid for twice —
	// but "a transaction spent it" has to mean that exact output. Matching on
	// value instead let any ordinary spend of a same-valued in-head UTxO cancel a
	// real deposit's recovery, and a 10 ADA in-head UTxO alongside a 10 ADA
	// top-up is exactly what the exact-amount carve produces.
	it('keeps a deposit recoverable when a transaction spends a different output of the same value', () => {
		const inHeadReference = `${'11'.repeat(32)}#0`;
		const depositReference = `${'44'.repeat(32)}#0`;
		const sharedOutput = serializeHydraSnapshotOutput(output({ lovelace: 10_000_000 }));
		const spentResult = serializeHydraSnapshotOutput(output({ lovelace: 9_000_000 }));

		// One ordinary in-head transaction: it spends the wallet's own 10 ADA UTxO
		// and pays 9 ADA back, the 1 ADA difference being the L2 fee.
		const inputs = TransactionInputs.new();
		inputs.add(TransactionInput.new(TransactionHash.from_bytes(Buffer.from('11'.repeat(32), 'hex')), 0));
		const outputs = TransactionOutputs.new();
		outputs.add(TransactionOutput.new(Address.from_bech32(ADDRESS), Value.new(BigNum.from_str('9000000'))));
		const body = TransactionBody.new_tx_body(inputs, outputs, BigNum.from_str('1000000'));
		const transaction = Transaction.new(body, TransactionWitnessSet.new());
		const cborHex = Buffer.from(transaction.to_bytes()).toString('hex');
		const txId = String(resolveTxHash(cborHex)).toLowerCase();
		const confirmed = [{ type: HydraTransactionType.TxConwayEra, cborHex, description: '', txId }];

		const previous = {
			headId: HEAD_ID,
			number: 4,
			version: 2,
			outputs: new Map([
				[inHeadReference, sharedOutput],
				[depositReference, sharedOutput],
			]),
			outputMultiset: new Map([[sharedOutput, 2]]),
			committedOutputs: new Map([[depositReference, sharedOutput]]),
			decommitOutputs: new Map<string, string>(),
		};
		// The transaction lands and the deposit passes its deadline and is
		// recovered on L1 in the same transition.
		const current = {
			headId: HEAD_ID,
			number: 5,
			version: 3,
			outputs: new Map([[`${txId}#0`, spentResult]]),
			outputMultiset: new Map([[spentResult, 1]]),
			committedOutputs: new Map<string, string>(),
			decommitOutputs: new Map<string, string>(),
		};

		expect(doesHydraTransactionTransitionReachSnapshot(previous, current, confirmed)).toBe(true);
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
			committedOutputs: new Map<string, string>(),
			decommitOutputs: new Map<string, string>(),
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
			committedOutputs: new Map<string, string>(),
			decommitOutputs: new Map<string, string>(),
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

	it('accepts an incremental-commit transition (top-up absorbed + new deposit pending)', () => {
		// Ground truth from a live head: snapshot N has the initial deposit pending
		// in utxoToCommit; snapshot N+1 absorbs it into utxo AND records a new
		// top-up deposit pending in utxoToCommit. No confirmed L2 txs.
		const deposit = serializeHydraSnapshotOutput(output({ lovelace: 5_000_000 }));
		const newDeposit = serializeHydraSnapshotOutput(output({ lovelace: 40_000_000 }));

		const previous = {
			headId: HEAD_ID,
			number: 1,
			version: 0,
			outputs: new Map([[`${'aa'.repeat(32)}#0`, deposit]]),
			outputMultiset: new Map([[deposit, 1]]), // combined = the pending deposit
			// It is pending in utxoToCommit, and named by the same reference it
			// carries in `outputs`: that is what tells the next snapshot apart from
			// one where a second deposit of the same size arrived.
			committedOutputs: new Map([[`${'aa'.repeat(32)}#0`, deposit]]),
			decommitOutputs: new Map<string, string>(),
		};
		const current = {
			headId: HEAD_ID,
			number: 2,
			version: 1,
			outputs: new Map([
				[`${'aa'.repeat(32)}#0`, deposit],
				[`${'bb'.repeat(32)}#0`, newDeposit],
			]),
			outputMultiset: new Map([
				[deposit, 1], // now absorbed into utxo (still in the combined set)
				[newDeposit, 1], // new top-up deposit, pending
			]),
			committedOutputs: new Map([[`${'bb'.repeat(32)}#0`, newDeposit]]), // the new deposit is what's pending now
			decommitOutputs: new Map<string, string>(),
		};

		expect(doesHydraTransactionTransitionReachSnapshot(previous, current, [])).toBe(true);
	});

	it('rejects an injected output not authenticated by the snapshot commit partition', () => {
		// Same transition, but the new output is NOT declared in utxoToCommit — i.e.
		// value that would appear from nowhere. The guard must still fail closed.
		const deposit = serializeHydraSnapshotOutput(output({ lovelace: 5_000_000 }));
		const forged = serializeHydraSnapshotOutput(output({ lovelace: 40_000_000 }));

		const previous = {
			headId: HEAD_ID,
			number: 1,
			version: 0,
			outputs: new Map([[`${'aa'.repeat(32)}#0`, deposit]]),
			outputMultiset: new Map([[deposit, 1]]),
			committedOutputs: new Map([[`${'aa'.repeat(32)}#0`, deposit]]),
			decommitOutputs: new Map<string, string>(),
		};
		const current = {
			headId: HEAD_ID,
			number: 2,
			version: 1,
			outputs: new Map([
				[`${'aa'.repeat(32)}#0`, deposit],
				[`${'bb'.repeat(32)}#0`, forged],
			]),
			outputMultiset: new Map([
				[deposit, 1],
				[forged, 1],
			]),
			committedOutputs: new Map<string, string>(), // forged output is NOT authenticated
			decommitOutputs: new Map<string, string>(),
		};

		expect(doesHydraTransactionTransitionReachSnapshot(previous, current, [])).toBe(false);
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
			committedOutputs: new Map<string, string>(),
			decommitOutputs: new Map<string, string>(),
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
			committedOutputs: new Map<string, string>(),
			decommitOutputs: new Map<string, string>(),
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
			committedOutputs: new Map<string, string>(),
			decommitOutputs: new Map<string, string>(),
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

// Recorded from two real hydra-node 2.4.1 nodes on preprod (see the fixture's
// description for the head and date). These are the only frames in this file
// whose signatures were made over the 2.4 formula, so they are what proves the
// formula — the synthetic vectors above can only prove the bytes.
const RECORDED_241 = JSON.parse(
	readFileSync(
		path.join(process.cwd(), 'src/lib/hydra/hydra/__fixtures__/recorded-signed-snapshots-2.4.1.json'),
		'utf8',
	),
) as {
	headId: string;
	partyKeys: string[];
	withDeposit: HydraSnapshotVerificationFrame;
	withoutDeposit: HydraSnapshotVerificationFrame;
	withDecommit: HydraSnapshotVerificationFrame;
};
const recorded241 = (which: 'withDeposit' | 'withoutDeposit' | 'withDecommit'): HydraSnapshotVerificationFrame =>
	JSON.parse(JSON.stringify(RECORDED_241[which])) as HydraSnapshotVerificationFrame;

describe('Hydra 2.4.1 recorded snapshot verification', () => {
	it('verifies a real 2.4.1 multisignature over a snapshot that binds a depositTxId', () => {
		const frame = recorded241('withDeposit');
		expect(frame.snapshot.depositTxId).toMatch(/^[0-9a-f]{64}$/);
		expect(Object.keys(frame.snapshot.utxoToCommit ?? {})).toHaveLength(1);
		const verified = verifyHydraSnapshot(frame, RECORDED_241.partyKeys);
		expect(verified.number).toBe(1);
		expect(verified.committedOutputs.size).toBe(1);
	});

	it('verifies a real 2.4.1 multisignature over a snapshot with no deposit (the outer sha256 still applies)', () => {
		const frame = recorded241('withoutDeposit');
		expect(frame.snapshot.depositTxId ?? null).toBeNull();
		const verified = verifyHydraSnapshot(frame, RECORDED_241.partyKeys);
		expect(verified.number).toBe(2);
		expect(verified.outputs.size).toBe(2);
	});

	it('verifies a real 2.4.1 multisignature over a snapshot that declares a decommit', () => {
		const verified = verifyHydraSnapshot(recorded241('withDecommit'), RECORDED_241.partyKeys);
		expect(verified.decommitOutputs.size).toBe(1);
	});

	it('fails closed for accumulator, state, signature, and party-order changes', () => {
		const keys = RECORDED_241.partyKeys;

		const badAccumulator = recorded241('withDeposit');
		badAccumulator.snapshot.accumulator = '00'.repeat(32);
		expect(() => verifyHydraSnapshot(badAccumulator, keys)).toThrow(/signature/);

		const badCommit = recorded241('withDeposit');
		const committed = Object.values(badCommit.snapshot.utxoToCommit ?? {})[0]!;
		committed.value.lovelace = Number(committed.value.lovelace) + 1;
		expect(() => verifyHydraSnapshot(badCommit, keys)).toThrow(/signature/);

		const badDepositTxId = recorded241('withDeposit');
		badDepositTxId.snapshot.depositTxId = 'ff'.repeat(32);
		expect(() => verifyHydraSnapshot(badDepositTxId, keys)).toThrow(/signature/);

		const badSettledState = recorded241('withoutDeposit');
		badSettledState.snapshot.utxo[`${'33'.repeat(32)}#0`] = output({ lovelace: 5_000_000 });
		expect(() => verifyHydraSnapshot(badSettledState, keys)).toThrow(/accumulator/);

		const badSignature = recorded241('withDeposit');
		badSignature.signatures.multiSignature[0] = '00'.repeat(64);
		expect(() => verifyHydraSnapshot(badSignature, keys)).toThrow(/signature/);

		expect(() => verifyHydraSnapshot(recorded241('withDeposit'), [...keys].reverse())).toThrow(/signature/);
	});
});

describe('doesHydraTransactionTransitionReachSnapshot conservation solver', () => {
	/**
	 * The transition equation has a free variable per value, and picking a point
	 * on it is not the same as deciding whether the equation has a solution.
	 *
	 * Both cases below turn on one serialized value being BOTH injected by a
	 * newly declared deposit and consumed by a confirmed transaction. Exact
	 * amounts collide constantly here: a top-up is an exact-amount carve
	 * committed whole to the participant's own wallet address, so a second
	 * top-up of the same size is byte-identical to what the first one left
	 * sitting in the head.
	 */
	function payingTransaction(spentReferences: string[], paidLovelace: number) {
		const inputs = TransactionInputs.new();
		for (const reference of spentReferences) {
			const [hash, index] = reference.split('#');
			inputs.add(TransactionInput.new(TransactionHash.from_bytes(Buffer.from(hash, 'hex')), Number(index)));
		}
		const outputs = TransactionOutputs.new();
		outputs.add(TransactionOutput.new(Address.from_bech32(ADDRESS), Value.new(BigNum.from_str(String(paidLovelace)))));
		const body = TransactionBody.new_tx_body(inputs, outputs, BigNum.from_str('1000000'));
		const cborHex = Buffer.from(Transaction.new(body, TransactionWitnessSet.new()).to_bytes()).toString('hex');
		const txId = String(resolveTxHash(cborHex)).toLowerCase();
		return { confirmed: [{ type: HydraTransactionType.TxConwayEra, cborHex, description: '', txId }], txId };
	}

	it('accepts a top-up declared in the same snapshot that spends an output of its size', () => {
		const spentTen = `${'11'.repeat(32)}#0`;
		const spentThree = `${'22'.repeat(32)}#0`;
		const depositReference = `${'44'.repeat(32)}#0`;
		const ten = serializeHydraSnapshotOutput(output({ lovelace: 10_000_000 }));
		const three = serializeHydraSnapshotOutput(output({ lovelace: 3_000_000 }));
		const thirteen = serializeHydraSnapshotOutput(output({ lovelace: 13_000_000 }));
		const { confirmed, txId } = payingTransaction([spentTen, spentThree], 13_000_000);

		const previous = {
			headId: HEAD_ID,
			number: 4,
			version: 2,
			outputs: new Map([
				[spentTen, ten],
				[spentThree, three],
			]),
			outputMultiset: new Map([
				[ten, 1],
				[three, 1],
			]),
			committedOutputs: new Map<string, string>(),
			decommitOutputs: new Map<string, string>(),
		};
		// The 10 ADA output is spent by the transaction and a fresh 10 ADA top-up
		// is declared in the very same snapshot. Both are legitimate; the value is
		// simultaneously consumed and injected.
		const current = {
			headId: HEAD_ID,
			number: 5,
			version: 3,
			outputs: new Map([
				[`${txId}#0`, thirteen],
				[depositReference, ten],
			]),
			outputMultiset: new Map([
				[thirteen, 1],
				[ten, 1],
			]),
			committedOutputs: new Map([[depositReference, ten]]),
			decommitOutputs: new Map<string, string>(),
		};

		expect(doesHydraTransactionTransitionReachSnapshot(previous, current, confirmed)).toBe(true);
	});

	it('refuses an output that appears in place of a settled decommit', () => {
		const keptReference = `${'11'.repeat(32)}#0`;
		const decommitReference = `${'33'.repeat(32)}#0`;
		const appearedReference = `${'55'.repeat(32)}#0`;
		const ten = serializeHydraSnapshotOutput(output({ lovelace: 10_000_000 }));
		const seven = serializeHydraSnapshotOutput(output({ lovelace: 7_000_000 }));

		const previous = {
			headId: HEAD_ID,
			number: 4,
			version: 2,
			outputs: new Map([
				[keptReference, ten],
				[decommitReference, seven],
			]),
			outputMultiset: new Map([
				[ten, 1],
				[seven, 1],
			]),
			committedOutputs: new Map<string, string>(),
			decommitOutputs: new Map([[decommitReference, seven]]),
		};
		// The decommit settled on L1 — that value has definitely left the head —
		// and an output of exactly its size appears with nothing creating it. The
		// authenticated removal must not be treated as optional slack that pays
		// for the arrival.
		const current = {
			headId: HEAD_ID,
			number: 5,
			version: 3,
			outputs: new Map([
				[keptReference, ten],
				[appearedReference, seven],
			]),
			outputMultiset: new Map([
				[ten, 1],
				[seven, 1],
			]),
			committedOutputs: new Map<string, string>(),
			decommitOutputs: new Map<string, string>(),
		};

		expect(doesHydraTransactionTransitionReachSnapshot(previous, current, [])).toBe(false);
	});
});

describe('hydraSnapshotSignableBytes (Hydra 2.4 commit slot)', () => {
	// Minimal frame in this file's existing inline style; only fields the builder reads.
	const base = {
		headId: '11'.repeat(16),
		signatures: { multiSignature: [] },
		snapshot: {
			headId: '11'.repeat(16),
			version: 1,
			number: 2,
			accumulator: '22'.repeat(48),
			confirmed: [],
			utxo: {},
			utxoToCommit: null,
			utxoToDecommit: null,
		},
	};
	const withDeposit = (depositTxId: string | null) => ({
		...base,
		snapshot: { ...base.snapshot, depositTxId },
	});

	it('re-hashes the commit slot with sha256 even without a deposit, leaving the decommit slot untouched', () => {
		const bytes = hydraSnapshotSignableBytes(base);
		// Pin the decommit slot — the 34 bytes immediately before the commit slot
		// — as the bare (non-re-hashed) sha256(empty). Both partitions are empty
		// here, so both slots would hash to the SAME bytes if the commit-slot
		// re-hash were accidentally applied to the wrong slot, or to both: this
		// assertion is what catches that "symmetry is tempting" mistake, which
		// the commit-slot assertion alone cannot.
		expect(bytes.subarray(bytes.length - 68, bytes.length - 34).toString('hex')).toBe(
			'5820e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
		);
		const commitSlot = bytes.subarray(bytes.length - 34); // 0x58 0x20 + 32 bytes
		expect(commitSlot.subarray(0, 2)).toEqual(Buffer.from([0x58, 0x20]));
		// Empty utxoToCommit: expected = sha256( sha256(empty concat) ) per the 2.4 formula.
		const inner = createHash('sha256').update(Buffer.alloc(0)).digest();
		const expected = createHash('sha256').update(inner).digest();
		expect(commitSlot.subarray(2)).toEqual(expected);
	});

	it('binds the deposit tx id into the commit-slot hash', () => {
		const depositTxId = 'b'.repeat(64);
		const bytes = hydraSnapshotSignableBytes(withDeposit(depositTxId));
		const inner = createHash('sha256').update(Buffer.alloc(0)).digest();
		const expected = createHash('sha256')
			.update(Buffer.concat([inner, Buffer.from(depositTxId, 'hex')]))
			.digest();
		expect(bytes.subarray(bytes.length - 32)).toEqual(expected);
		expect(bytes.length).toBe(hydraSnapshotSignableBytes(base).length); // slot size unchanged
	});

	it('treats an explicit null depositTxId like an absent one', () => {
		expect(hydraSnapshotSignableBytes(withDeposit(null))).toEqual(hydraSnapshotSignableBytes(base));
	});

	it('rejects a malformed depositTxId', () => {
		// Two independent ways the check can fail — pinned separately so a broken
		// length check and a broken hex-content check can't hide each other the
		// way a single too-short, non-hex value like 'zz' would.
		expect(() => hydraSnapshotSignableBytes(withDeposit('g'.repeat(64)))).toThrow(HydraProtocolError); // right length, not hex
		expect(() => hydraSnapshotSignableBytes(withDeposit('a'.repeat(63)))).toThrow(HydraProtocolError); // valid hex, wrong length
	});
});
