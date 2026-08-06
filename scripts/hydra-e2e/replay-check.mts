/**
 * Replay a hydra-node's recorded history through the real transition check.
 *
 * The service verifies every signed state it is told about, and when that check
 * is wrong the only symptom is a reconnect loop: the head never forms a live
 * session and every L2 escrow operation fails closed, with nothing saying which
 * transition was rejected or why. This replays a node's own log through the
 * production verifier and names the failing step.
 *
 *   pnpm exec tsx scripts/hydra-e2e/replay-check.mts <path-to>/node.log
 *
 * Run it as step 2 of the hydra-node upgrade checklist in
 * docs/adr/0012-hydra-snapshot-verification-and-upgrades.md.
 *
 * Test support only.
 */
import fs from 'node:fs';
import {
	doesHydraTransactionTransitionReachSnapshot,
	serializeHydraSnapshotOutput,
	type VerifiedHydraSnapshot,
} from '@/lib/hydra/hydra/snapshot-verification';

const logPath = process.argv[2];
if (!logPath) throw new Error('usage: replay-check.mts <path-to>/node.log');

type Raw = {
	number: number;
	version: number;
	utxo: Record<string, unknown>;
	utxoToCommit: Record<string, unknown> | null;
	utxoToDecommit: Record<string, unknown> | null;
	confirmed: Array<{ txId?: string; cborHex: string }>;
};

function walk(value: unknown, out: Raw[]): void {
	if (Array.isArray(value)) {
		for (const entry of value) walk(entry, out);
		return;
	}
	if (value === null || typeof value !== 'object') return;
	const record = value as Record<string, unknown>;
	if (record.tag === 'SnapshotConfirmed' && typeof record.snapshot === 'object' && record.snapshot !== null) {
		out.push(record.snapshot as unknown as Raw);
	}
	if (record.tag === 'DecommitRequested' && typeof record.decommitTx === 'object' && record.decommitTx !== null) {
		const tx = record.decommitTx as { txId?: string; cborHex?: string };
		if (tx.txId && tx.cborHex) decommitTxs.set(tx.txId.toLowerCase(), { txId: tx.txId, cborHex: tx.cborHex });
	}
	for (const nested of Object.values(record)) walk(nested, out);
}

const byNumber = new Map<number, Raw>();
/** Decommit transactions the history hands us in DecommitRequested. */
const decommitTxs = new Map<string, { txId: string; cborHex: string }>();
for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
	if (!line.includes('SnapshotConfirmed') && !line.includes('DecommitRequested')) continue;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		continue;
	}
	const found: Raw[] = [];
	walk(parsed, found);
	for (const snapshot of found) if (!byNumber.has(snapshot.number)) byNumber.set(snapshot.number, snapshot);
}

function multiset(values: Iterable<string>): Map<string, number> {
	const counts = new Map<string, number>();
	for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
	return counts;
}

function toVerified(raw: Raw): VerifiedHydraSnapshot {
	// Canonical set, exactly as verifyHydraSnapshot builds it: utxo together with
	// both pending partitions, because that is what the accumulator signs.
	const outputs = new Map<string, string>();
	for (const partition of [raw.utxo ?? {}, raw.utxoToCommit ?? {}, raw.utxoToDecommit ?? {}]) {
		for (const [reference, output] of Object.entries(partition)) {
			outputs.set(reference.toLowerCase(), serializeHydraSnapshotOutput(output as never));
		}
	}
	const partition = (source: Record<string, unknown> | null) =>
		multiset(Object.values(source ?? {}).map((output) => serializeHydraSnapshotOutput(output as never)));
	return {
		headId: 'head',
		number: raw.number,
		version: raw.version,
		outputs,
		outputMultiset: multiset(outputs.values()),
		committedMultiset: partition(raw.utxoToCommit),
		decommitMultiset: partition(raw.utxoToDecommit),
	} as VerifiedHydraSnapshot;
}

const numbers = [...byNumber.keys()].sort((a, b) => a - b);
console.log('snapshots:', numbers.join(', '));
for (let index = 1; index < numbers.length; index++) {
	const previousNumber = numbers[index - 1];
	const currentNumber = numbers[index];
	if (previousNumber === undefined || currentNumber === undefined) continue;
	const previousRaw = byNumber.get(previousNumber);
	const currentRaw = byNumber.get(currentNumber);
	if (!previousRaw || !currentRaw) continue;
	// The decommit transaction is carried in the partition, not in `confirmed`,
	// but it is a real transaction and it is what explains the delta — including
	// its own L1 fee. Feed it through the same conservation walk.
	const pendingDecommitTxIds = new Set(
		Object.keys(currentRaw.utxoToDecommit ?? {}).map((reference) =>
			reference.slice(0, reference.indexOf('#')).toLowerCase(),
		),
	);
	const extra = [...pendingDecommitTxIds]
		.map((txId) => decommitTxs.get(txId))
		.filter((transaction): transaction is { txId: string; cborHex: string } => transaction !== undefined);
	const ok = doesHydraTransactionTransitionReachSnapshot(toVerified(previousRaw), toVerified(currentRaw), [
		...(currentRaw.confirmed ?? []).map((tx) => ({ txId: tx.txId ?? null, cborHex: tx.cborHex })),
		...extra,
	] as never);
	console.log(
		`${previousRaw.number} -> ${currentRaw.number}: ${ok ? 'ok' : 'FAILS'}  (confirmed=${(currentRaw.confirmed ?? []).length}, commit=${Object.keys(currentRaw.utxoToCommit ?? {}).length}, decommit=${Object.keys(currentRaw.utxoToDecommit ?? {}).length})`,
	);
}
