/**
 * Every shape a signed snapshot transition can take, enumerated.
 *
 * This check is the one that can take a head down completely: rejecting a
 * history means no verified session, no head clock, and every L2 escrow
 * operation failing closed while the head still reports itself Open. Two
 * legitimate protocol behaviours had already been missed that way — a decommit
 * carrying its own L1 fee, and a deposit recovered instead of absorbed — both
 * found only after the fact.
 *
 * So the shapes are enumerated rather than sampled. A snapshot carries exactly
 * three pieces of state (`utxo`, `utxoToCommit`, `utxoToDecommit`) plus its
 * confirmed transactions, and this covers what can happen to each of them,
 * including the cases that must still be refused. The negatives matter as much
 * as the positives: every fix here widens what is accepted, and without them
 * the check could be widened until it asserts nothing.
 */

import { describe, expect, it } from '@jest/globals';
import {
	doesHydraTransactionTransitionReachSnapshot,
	serializeHydraSnapshotOutput,
	type VerifiedHydraSnapshot,
} from './snapshot-verification';

const ADDRESS =
	'addr_test1qzt3wm0d6ukdgazpl7f2w5x2jk6ep6pdut6zymc63d6nzn9jnp724m2jjux7rpdrasv05wh93papl5jf7fy8t5up2yns9lkwvm';

function output(lovelace: number): string {
	return serializeHydraSnapshotOutput({
		address: ADDRESS,
		datum: null,
		datumhash: null,
		inlineDatum: null,
		inlineDatumRaw: null,
		referenceScript: null,
		value: { lovelace },
	} as never);
}

/**
 * One output, named.
 *
 * The name is the UTxO reference and it is what carries identity across a
 * transition: the same entry in two consecutive snapshots is the same output,
 * and a deposit that was absorbed keeps its reference on the way from
 * `utxoToCommit` into `utxo`. Values collide all the time here on purpose —
 * a withdrawal and a top-up of the same size to the same wallet are identical
 * bytes — so nothing below may be identified by its value.
 */
type Entry = { reference: string; value: string };

function at(name: string, value: string): Entry {
	return { reference: `${name.padEnd(64, '0')}#0`, value };
}

function multiset(values: Iterable<string>): Map<string, number> {
	const counts = new Map<string, number>();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	return counts;
}

function referenceMap(entries: Entry[]): Map<string, string> {
	return new Map(entries.map(({ reference, value }) => [reference, value]));
}

/** A snapshot's canonical set is utxo together with both pending partitions. */
function snapshot(
	number: number,
	utxo: Entry[],
	commit: Entry[],
	decommit: Entry[],
	depositTxId: string | null = null,
): VerifiedHydraSnapshot {
	const outputs = referenceMap([...utxo, ...commit, ...decommit]);
	return {
		headId: 'head',
		number,
		version: number - 1,
		outputs,
		outputMultiset: multiset(outputs.values()),
		committedOutputs: referenceMap(commit),
		decommitOutputs: referenceMap(decommit),
		depositTxId,
	};
}

// Hydra 2.4: the deposit tx id a snapshot's pending commit came from. Two
// distinct ids, named for what they stand for below.
const DEPOSIT_D = 'd'.repeat(64);
const DEPOSIT_D2 = 'e'.repeat(64);

const A = at('a', output(10_000_000));
const B = at('b', output(7_000_000));
const C = at('c', output(5_000_000));
// Smaller than C on purpose: a decommit pays its own L1 fee out of the value
// that travels, so what leaves is never quite what was committed.
const D = at('d', output(4_829_879));
// Same value as A, different output. This is the ordinary case, not a contrived
// one: a withdrawal and a top-up of the same size to the same wallet serialize
// identically, and so do two escrow outputs of the same price.
const A_TWIN = at('a2', A.value);
const A_DEPOSIT = at('adep', A.value);
const A_DECOMMIT = at('adec', A.value);
const C_GHOST = at('cghost', C.value);

describe('signed-state transition shapes', () => {
	const cases: Array<[string, VerifiedHydraSnapshot, VerifiedHydraSnapshot, boolean]> = [
		['baseline: nothing changes', snapshot(1, [A], [], []), snapshot(2, [A], [], []), true],
		['commit pending -> absorbed', snapshot(1, [A], [C], []), snapshot(2, [A, C], [], []), true],
		['commit pending stays pending', snapshot(1, [A], [C], []), snapshot(2, [A], [C], []), true],
		['two commits pending, one absorbed', snapshot(1, [A], [B, C], []), snapshot(2, [A, B], [C], []), true],
		[
			'DEPOSIT RECOVERED: pending commit vanishes, never absorbed',
			snapshot(1, [A], [C], []),
			snapshot(2, [A], [], []),
			true,
		],
		['decommit declared (no tx supplied)', snapshot(1, [A, C], [], []), snapshot(2, [A], [], [D]), false],
		['decommit finalized: previous decommit gone', snapshot(1, [A], [], [D]), snapshot(2, [A], [], []), true],
		['decommit stays pending', snapshot(1, [A], [], [D]), snapshot(2, [A], [], [D]), true],
		['commit and decommit pending together', snapshot(1, [A], [C], [D]), snapshot(2, [A, C], [], [D]), true],
		['value appears from nowhere', snapshot(1, [A], [], []), snapshot(2, [A, B], [], []), false],
		// A deposit is an injection once, on the snapshot that declares it. It then
		// sits in utxoToCommit for as many snapshots as the increment takes to
		// land, and granting it injection slack again on each one lets an output of
		// its value materialise out of nothing for as long as it is pending.
		[
			'a deposit pending in both snapshots does not excuse a second output of its value',
			snapshot(1, [A], [C], []),
			snapshot(2, [A, C_GHOST], [C], []),
			false,
		],
		// The normal ending for a deposit is absorption, and an absorbed deposit
		// has not left: it keeps its reference on the way into utxo. Treating it as
		// recoverable anyway pays for a disappearance somewhere else — here `A`
		// leaves with no transaction naming it, under cover of a deposit and a
		// decommit of the same size.
		[
			'an absorbed deposit does not pay for an unexplained disappearance',
			snapshot(1, [A, A_TWIN], [A_DEPOSIT], [A_DECOMMIT]),
			snapshot(2, [A_TWIN, A_DEPOSIT], [], []),
			false,
		],
		['value vanishes with nothing declaring it', snapshot(1, [A, B], [], []), snapshot(2, [A], [], []), false],
		['non-consecutive snapshot numbers', snapshot(1, [A], [], []), snapshot(3, [A], [], []), false],
		// Hydra 2.4: `depositTxId` names the on-chain deposit `utxoToCommit` came
		// from. Attaching it to the already-accepted absorb/recover shapes must
		// not change their outcome — the txid tightens what the check refuses, it
		// does not open a new pathway to acceptance. These two are presence
		// REGRESSION guards, not new deposit-lifecycle coverage: the shapes
		// themselves are already covered above (`commit pending -> absorbed`,
		// `DEPOSIT RECOVERED`); what's new here is only that the field is set.
		[
			'deposit txid present (regression guard): commit pending -> absorbed still accepted',
			snapshot(1, [A], [C], [], DEPOSIT_D),
			snapshot(2, [A, C], [], []),
			true,
		],
		[
			'deposit txid present (regression guard): DEPOSIT RECOVERED still accepted',
			snapshot(1, [A], [C], [], DEPOSIT_D),
			snapshot(2, [A], [], []),
			true,
		],
		// The same ghost-output negative as above (a value-colliding output that
		// was never declared as pending), now with depositTxId values attached (D
		// on `previous`, a different D2 on `current`). Nothing in the transition
		// check reads depositTxId as evidence for an output — this is refused by
		// the pre-existing per-reference conservation accounting alone, exactly as
		// it is without the field. This case is a regression guard: it would still
		// fail with `depositTxId` deleted from both snapshots, proving the field's
		// mere presence does not loosen what that accounting refuses.
		[
			'deposit txid: a differently-attributed ghost output is still refused',
			snapshot(1, [A], [C], [], DEPOSIT_D),
			snapshot(2, [A, C_GHOST], [C], [], DEPOSIT_D2),
			false,
		],
		// The inverse of the case above, and ACCEPTED on purpose: a depositTxId
		// with no pending commit is a shape upstream does not rule out — it models
		// `utxoToCommit` and `depositTxId` as independent `Maybe`s — and refusing
		// it would change no acceptance decision (with no committed outputs there
		// are no commit allowances to derive) while giving one unmodelled frame the
		// power to reject a head's history permanently, since replay restarts from
		// the beginning on every reconnect. ADR 0012's whole doctrine is that the
		// check is neither widened nor tightened without a recorded fixture.
		[
			'deposit txid present with no pending commit is accepted, not refused as unmodelled',
			snapshot(1, [A], [], []),
			snapshot(2, [A], [], [], DEPOSIT_D),
			true,
		],
	];

	it.each(cases.map(([name, previous, current, expected]) => [name, previous, current, expected] as const))(
		'%s',
		(_name, previous, current, expected) => {
			expect(doesHydraTransactionTransitionReachSnapshot(previous, current, [])).toBe(expected);
		},
	);
});
