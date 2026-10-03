/**
 * The transition check, run against a real hydra-node's recorded history.
 *
 * Every other test in this area asserts against a snapshot shape someone wrote
 * by hand, which is exactly how the decommit bug shipped: the accounting was
 * consistent with what we believed Hydra emits, and Hydra emits something else.
 * A head that had been withdrawn from once could never replay its history
 * again, so it never formed a live session, so every L2 escrow operation failed
 * closed — and the only symptom was a reconnect loop naming no transition.
 *
 * The fixture is captured verbatim from a preprod head that did the things the
 * hand-written tests could not: two incremental commits, a decommit carrying
 * its own L1 fee, and an escrow lock. Regenerate it with
 * `scripts/hydra-e2e/replay-check.mts` against a node.log when Hydra changes.
 */

import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { HydraTransactionType, type HydraTransaction } from './types';
import {
	doesHydraTransactionTransitionReachSnapshot,
	serializeHydraSnapshotOutput,
	type VerifiedHydraSnapshot,
} from './snapshot-verification';

type FixtureOutput = Parameters<typeof serializeHydraSnapshotOutput>[0];
/** Only the fields the transition check reads; the rest is Hydra envelope noise. */
type FixtureTransaction = HydraTransaction;
type FixtureSnapshot = {
	number: number;
	version: number;
	utxo: Record<string, FixtureOutput>;
	utxoToCommit: Record<string, FixtureOutput> | null;
	utxoToDecommit: Record<string, FixtureOutput> | null;
	/** hydra-node 2.4: the deposit `utxoToCommit` came from. Absent from 2.3 recordings. */
	depositTxId?: string | null;
	confirmed: Array<{ txId: string; cborHex: string }>;
};

// From the repo root rather than __dirname: the ESM test runner rewrites module
// paths, and this file is data the runner does not resolve.
const FIXTURE_PATH = path.join(process.cwd(), 'src/lib/hydra/hydra/__fixtures__/recorded-head-history.json');

type HistoryFixture = {
	description: string;
	snapshots: FixtureSnapshot[];
	decommitTransactions: Array<{ txId: string; cborHex: string }>;
};
const loadFixture = (file: string): HistoryFixture =>
	JSON.parse(
		readFileSync(path.join(process.cwd(), 'src/lib/hydra/hydra/__fixtures__', file), 'utf8'),
	) as HistoryFixture;

// Two recordings, kept side by side on purpose. The 2.3 one holds a decommit
// whose output is smaller than its input — a burned in-head fee, the H65 bug
// the service has since fixed — and is the only recording that can guard the
// verifier's tolerance of it, because a fixed service never produces one. The
// 2.4.1 one is the first with `depositTxId` and the new on-chain deposit
// period, recorded from a full preprod lifecycle. Each is evidence of what one
// node version actually signed; neither replaces the other.
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as HistoryFixture;
const fixture241 = loadFixture('recorded-head-history-2.4.1.json');

const HEAD_ID = 'recorded-head';

/** The envelope fields Hydra sends and the fixture drops, since nothing reads them. */
function withEnvelope(transaction: { txId: string; cborHex: string }): FixtureTransaction {
	return { ...transaction, type: HydraTransactionType.TxConwayEra, description: '' };
}

function multiset(values: Iterable<string>): Map<string, number> {
	const counts = new Map<string, number>();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	return counts;
}

/** The canonical set the accumulator signs: utxo together with both partitions. */
function toVerified(snapshot: FixtureSnapshot): VerifiedHydraSnapshot {
	const outputs = new Map<string, string>();
	for (const partition of [snapshot.utxo, snapshot.utxoToCommit ?? {}, snapshot.utxoToDecommit ?? {}]) {
		for (const [reference, output] of Object.entries(partition)) {
			outputs.set(reference.toLowerCase(), serializeHydraSnapshotOutput(output));
		}
	}
	const partitionReferences = (source: Record<string, FixtureOutput> | null) =>
		new Map(
			Object.entries(source ?? {}).map(([reference, output]) => [
				reference.toLowerCase(),
				serializeHydraSnapshotOutput(output),
			]),
		);
	return {
		headId: HEAD_ID,
		number: snapshot.number,
		version: snapshot.version,
		outputs,
		outputMultiset: multiset(outputs.values()),
		committedOutputs: partitionReferences(snapshot.utxoToCommit),
		decommitOutputs: partitionReferences(snapshot.utxoToDecommit),
	};
}

/**
 * The decommit transactions a snapshot's pending partition names.
 *
 * Mirrors what the node does: a decommit is reported in DecommitRequested and
 * in the partition, never in `confirmed`, so the conservation walk has to be
 * handed it or the value it moves has nothing accounting for it.
 */
function decommitTransactionsFor(snapshot: FixtureSnapshot, source: HistoryFixture = fixture): FixtureTransaction[] {
	const wanted = new Set(
		Object.keys(snapshot.utxoToDecommit ?? {}).map((reference) =>
			reference.slice(0, reference.indexOf('#')).toLowerCase(),
		),
	);
	return source.decommitTransactions
		.filter((transaction) => wanted.has(transaction.txId.toLowerCase()))
		.map(withEnvelope);
}

describe('recorded hydra-node history', () => {
	const snapshots = [...fixture.snapshots].sort((left, right) => left.number - right.number);

	it('covers the shapes the hand-written tests do not', () => {
		expect(snapshots.length).toBeGreaterThanOrEqual(4);
		expect(snapshots.some((snapshot) => Object.keys(snapshot.utxoToCommit ?? {}).length > 0)).toBe(true);
		expect(snapshots.some((snapshot) => Object.keys(snapshot.utxoToDecommit ?? {}).length > 0)).toBe(true);
		expect(snapshots.some((snapshot) => snapshot.confirmed.length > 0)).toBe(true);
	});

	// The decommit carries a real L1 fee, so the output it produces is worth less
	// than the one it consumed. That difference is the whole reason this fixture
	// exists: it is legitimate, signed by every party, and used to be rejected.
	it('contains a decommit whose output is smaller than the input it replaces', () => {
		const committed = Object.values(snapshots[1]?.utxoToCommit ?? {});
		const decommitted = Object.values(snapshots[2]?.utxoToDecommit ?? {});
		const lovelaceOf = (output: FixtureOutput) => Number((output as { value: { lovelace: number } }).value.lovelace);
		expect(decommitted).toHaveLength(1);
		const leaving = lovelaceOf(decommitted[0]!);
		expect(committed.some((output) => lovelaceOf(output) > leaving)).toBe(true);
	});

	it.each(fixture.snapshots.slice(1).map((snapshot, index) => [index + 1, snapshot.number] as const))(
		'accepts the transition into snapshot %s (number %s)',
		(index) => {
			const previous = snapshots[index - 1]!;
			const current = snapshots[index]!;
			const transactions = [...current.confirmed.map(withEnvelope), ...decommitTransactionsFor(current)];

			expect(doesHydraTransactionTransitionReachSnapshot(toVerified(previous), toVerified(current), transactions)).toBe(
				true,
			);
		},
	);

	// The relaxation that would have "fixed" the outage by waving the decommit
	// through must stay unnecessary: without the transaction the walk still has
	// to fail, or nothing is binding the confirmed list any more.
	it('still rejects the decommit transition when the transaction is withheld', () => {
		const withDecommit = snapshots.findIndex((snapshot) => Object.keys(snapshot.utxoToDecommit ?? {}).length > 0);
		expect(withDecommit).toBeGreaterThan(0);
		const previous = snapshots[withDecommit - 1]!;
		const current = snapshots[withDecommit]!;

		expect(
			doesHydraTransactionTransitionReachSnapshot(
				toVerified(previous),
				toVerified(current),
				current.confirmed.map(withEnvelope),
			),
		).toBe(false);
	});
});

describe('recorded hydra-node 2.4.1 history', () => {
	const snapshots = [...fixture241.snapshots].sort((left, right) => left.number - right.number);

	it('is the 2.4.1 preprod recording and covers the 2.4 shapes', () => {
		expect(fixture241.description).toContain('2.4.1');
		expect(snapshots.length).toBeGreaterThanOrEqual(4);
		// The incremental commit that 2.4 binds to its L1 deposit transaction.
		const commit = snapshots.find((snapshot) => Object.keys(snapshot.utxoToCommit ?? {}).length > 0);
		expect(commit?.depositTxId).toMatch(/^[0-9a-f]{64}$/);
		// A withdrawal, declared in the partition and carried by DecommitRequested.
		expect(snapshots.some((snapshot) => Object.keys(snapshot.utxoToDecommit ?? {}).length > 0)).toBe(true);
		expect(snapshots.some((snapshot) => snapshot.confirmed.length > 0)).toBe(true);
	});

	it('names every decommit transaction its partitions declare', () => {
		for (const snapshot of snapshots) {
			const declared = Object.keys(snapshot.utxoToDecommit ?? {}).length;
			expect(decommitTransactionsFor(snapshot, fixture241)).toHaveLength(declared > 0 ? 1 : 0);
		}
	});

	it.each(fixture241.snapshots.slice(1).map((snapshot, index) => [index + 1, snapshot.number] as const))(
		'accepts the transition into snapshot %s (number %s)',
		(index) => {
			const previous = snapshots[index - 1]!;
			const current = snapshots[index]!;
			const transactions = [...current.confirmed.map(withEnvelope), ...decommitTransactionsFor(current, fixture241)];

			expect(doesHydraTransactionTransitionReachSnapshot(toVerified(previous), toVerified(current), transactions)).toBe(
				true,
			);
		},
	);

	// The 2.3 recording's "withheld transaction is rejected" property does not
	// transfer here, and the reason is worth pinning: this head charges no fee,
	// so the withdrawn output is byte-for-byte the output it replaces. The
	// canonical set is a multiset of serialized outputs, so moving one from
	// `utxo` to `utxoToDecommit` changes nothing the conservation walk can see,
	// and a withheld transaction looks like a no-op. That is why the 2.3
	// recording — a decommit that burned an in-head fee — stays beside this one:
	// it is the only recording that binds the decommit transaction.
	it('moves a fee-free decommit byte-for-byte, which is why the 2.3 recording is kept', () => {
		const withDecommit = snapshots.findIndex((snapshot) => Object.keys(snapshot.utxoToDecommit ?? {}).length > 0);
		expect(withDecommit).toBeGreaterThan(0);
		const previous = snapshots[withDecommit - 1]!;
		const current = snapshots[withDecommit]!;
		const [leaving] = Object.values(current.utxoToDecommit ?? {});
		const replaced = Object.entries(previous.utxo).filter(([reference]) => !(reference in current.utxo));
		expect(replaced).toHaveLength(1);
		expect(serializeHydraSnapshotOutput(leaving!)).toBe(serializeHydraSnapshotOutput(replaced[0]![1]));
	});
});
