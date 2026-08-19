/**
 * A deposit still in flight at close is not part of the fanout.
 *
 * The accumulator is computed over all three snapshot partitions, because that
 * is what the signatures commit to — so the canonical multiset includes
 * `utxoToCommit`. The fanout does not: a deposit whose increment has not landed
 * on L1 never entered the head, its funds are at the deposit script where the
 * depositor recovers them, and paying it out as well would be a double spend.
 *
 * Requiring the full canonical multiset therefore made every fanout reference
 * unresolvable for a head closed with any deposit in flight. The inputs are
 * deterministic — replayed history plus the expected snapshot number — so it
 * failed identically on every poll, `prepareFinalHandoff` returned null
 * forever, and every payment in the head stayed pinned to in-head UTxOs that no
 * longer exist, on a head already Final with no protocol action left.
 *
 * A pending DECOMMIT is the mirror image and must still be expected: the
 * decrement has not landed, so those funds are still in the head's L1 UTxO and
 * the fanout does pay them out.
 */

import { describe, expect, it } from '@jest/globals';
import {
	resolveVerifiedHydraFanoutReferences,
	serializeHydraSnapshotOutput,
	type VerifiedHydraSnapshot,
} from './snapshot-verification';

const ADDRESS =
	'addr_test1qp6ctf8vcjxzd53et7p0hlqyncn59stnfd4g8mp978v33r6dlzjvt4s2t6wn3v993pu9aea4h3z0jeyn6lsvw6hugtesfx55dd';

function output(lovelace: number) {
	return {
		address: ADDRESS,
		value: { lovelace },
		referenceScript: null,
		datumhash: null,
		inlineDatum: null,
		inlineDatumRaw: null,
		datum: null,
	};
}

const kept = serializeHydraSnapshotOutput(output(7_000_000));
const deposited = serializeHydraSnapshotOutput(output(3_000_000));
const leaving = serializeHydraSnapshotOutput(output(2_000_000));

const KEPT_REF = `${'11'.repeat(32)}#0`;
const DEPOSIT_REF = `${'12'.repeat(32)}#0`;
const DECOMMIT_REF = `${'13'.repeat(32)}#0`;
const FANOUT_KEPT = `${'22'.repeat(32)}#0`;
const FANOUT_DEPOSIT = `${'22'.repeat(32)}#1`;
const FANOUT_DECOMMIT = `${'22'.repeat(32)}#2`;

function snapshot(overrides: Partial<VerifiedHydraSnapshot> = {}): VerifiedHydraSnapshot {
	return {
		headId: 'ab'.repeat(16),
		number: 9,
		version: 3,
		outputs: new Map([
			[KEPT_REF, kept],
			[DEPOSIT_REF, deposited],
		]),
		outputMultiset: new Map([
			[kept, 1],
			[deposited, 1],
		]),
		committedOutputs: new Map([[DEPOSIT_REF, deposited]]),
		decommitOutputs: new Map<string, string>(),
		...overrides,
	};
}

describe('fanout resolution with a deposit in flight', () => {
	it('resolves the outputs the head actually paid out', () => {
		const resolved = resolveVerifiedHydraFanoutReferences(snapshot(), new Map([[FANOUT_KEPT, kept]]));

		expect(resolved).toEqual([{ txHash: '22'.repeat(32), outputIndex: 0, snapshotNumber: 9, serializedOutput: kept }]);
	});

	// The increment can land on L1 in the moment before the close, which moves
	// the same outputs into `utxo` — and our recorded snapshot may not have seen
	// that yet. Both readings of the same signed state are legitimate.
	it('still resolves when the deposit did make it into the fanout', () => {
		const resolved = resolveVerifiedHydraFanoutReferences(
			snapshot(),
			new Map([
				[FANOUT_KEPT, kept],
				[FANOUT_DEPOSIT, deposited],
			]),
		);

		expect(resolved).toHaveLength(2);
	});

	it('refuses a fanout that is missing an output no deposit accounts for', () => {
		expect(resolveVerifiedHydraFanoutReferences(snapshot(), new Map([[FANOUT_DEPOSIT, deposited]]))).toBeNull();
	});

	// Nothing is in flight, so the full canonical set is the only answer.
	it('is unchanged for a head with no deposit pending', () => {
		const plain = snapshot({
			outputs: new Map([[KEPT_REF, kept]]),
			outputMultiset: new Map([[kept, 1]]),
			committedOutputs: new Map<string, string>(),
		});

		expect(resolveVerifiedHydraFanoutReferences(plain, new Map([[FANOUT_KEPT, kept]]))).toHaveLength(1);
		expect(resolveVerifiedHydraFanoutReferences(plain, new Map())).toBeNull();
	});

	// A decommit that has not landed leaves the funds in the head, so the fanout
	// pays them out and the expectation must keep them.
	it('keeps a pending decommit in the expected fanout', () => {
		const withDecommit = snapshot({
			outputs: new Map([
				[KEPT_REF, kept],
				[DECOMMIT_REF, leaving],
			]),
			outputMultiset: new Map([
				[kept, 1],
				[leaving, 1],
			]),
			committedOutputs: new Map<string, string>(),
			decommitOutputs: new Map([[DECOMMIT_REF, leaving]]),
		});

		expect(
			resolveVerifiedHydraFanoutReferences(
				withDecommit,
				new Map([
					[FANOUT_KEPT, kept],
					[FANOUT_DECOMMIT, leaving],
				]),
			),
		).toHaveLength(2);
		expect(resolveVerifiedHydraFanoutReferences(withDecommit, new Map([[FANOUT_KEPT, kept]]))).toBeNull();
	});
});
