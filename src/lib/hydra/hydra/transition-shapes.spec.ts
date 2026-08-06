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

function multiset(values: string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	return counts;
}

/** A snapshot's canonical set is utxo together with both pending partitions. */
function snapshot(number: number, utxo: string[], commit: string[], decommit: string[]): VerifiedHydraSnapshot {
	const all = [...utxo, ...commit, ...decommit];
	const outputs = new Map<string, string>();
	all.forEach((value, index) => outputs.set(`${'aa'.repeat(32)}#${index}`, value));
	return {
		headId: 'head',
		number,
		version: number - 1,
		outputs,
		outputMultiset: multiset(all),
		committedMultiset: multiset(commit),
		decommitMultiset: multiset(decommit),
	};
}

const A = output(10_000_000);
const B = output(7_000_000);
const C = output(5_000_000);
// Smaller than C on purpose: a decommit pays its own L1 fee out of the value
// that travels, so what leaves is never quite what was committed.
const D = output(4_829_879);

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
		['value vanishes with nothing declaring it', snapshot(1, [A, B], [], []), snapshot(2, [A], [], []), false],
		['non-consecutive snapshot numbers', snapshot(1, [A], [], []), snapshot(3, [A], [], []), false],
	];

	it.each(cases.map(([name, previous, current, expected]) => [name, previous, current, expected] as const))(
		'%s',
		(_name, previous, current, expected) => {
			expect(doesHydraTransactionTransitionReachSnapshot(previous, current, [])).toBe(expected);
		},
	);
});
