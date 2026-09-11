/**
 * Regenerate the two recorded Hydra fixtures from a node's WebSocket history.
 *
 * Both fixtures are real, signed node output, and both used to be extracted by
 * hand. This makes step 3 of the hydra-node upgrade checklist in
 * docs/adr/0012-hydra-snapshot-verification-and-upgrades.md repeatable: capture
 * the history (`ws://<node>?history=yes`, one frame per line), then
 *
 *   pnpm exec tsx scripts/hydra-e2e/regenerate-fixtures.mts <history.jsonl> \
 *     --from <snapshot number> --count <n> --label "<hydra version, network, head, date>" \
 *     [--history-out <file name>]
 *
 * Writes:
 *   src/lib/hydra/hydra/__fixtures__/recorded-snapshot-frames.json
 *     the key shape of every SnapshotConfirmed frame (one per distinct shape,
 *     payloads elided) — what protocol-drift.spec.ts models against.
 *   src/lib/hydra/hydra/__fixtures__/recorded-head-history.json (or --history-out)
 *     `count` consecutive snapshots starting at `from`, plus the decommit
 *     transactions their pending partitions name — what
 *     recorded-history.spec.ts replays through the transition check. Use
 *     --history-out to add a recording beside an existing one rather than
 *     replace it: a recording is evidence of what one node version did, and
 *     an older one can guard a case a newer node no longer produces.
 *
 * The window is the operator's choice, and recorded-history.spec.ts is strict
 * about it: index 1 must declare a commit, index 2 must declare exactly one
 * decommit, and the slice must chain. Pick the window from the numbers this
 * script prints, do not loosen the spec.
 *
 * Test support only.
 */
import fs from 'node:fs';
import path from 'node:path';

type Frame = Record<string, unknown> & { tag: string };
type Snapshot = {
	number: number;
	version: number;
	utxo: Record<string, unknown>;
	utxoToCommit: Record<string, unknown> | null;
	utxoToDecommit: Record<string, unknown> | null;
	depositTxId?: string | null;
	confirmed: Array<{ txId: string; cborHex: string }>;
};

const args = process.argv.slice(2);
const historyPath = args.find((a) => !a.startsWith('--'));
const opt = (name: string): string | undefined => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? undefined : args[i + 1];
};
if (!historyPath) {
	console.error('usage: regenerate-fixtures.mts <history.jsonl> --from <number> --count <n> --label "<text>"');
	process.exit(2);
}
const from = Number(opt('from'));
const count = Number(opt('count') ?? '4');
const label = opt('label') ?? 'hydra-node (unlabelled recording)';
const historyOut = opt('history-out') ?? 'recorded-head-history.json';

const frames: Frame[] = fs
	.readFileSync(historyPath, 'utf8')
	.split('\n')
	.filter((line) => line.trim() !== '')
	.map((line) => JSON.parse(line) as Frame);

const snapshotFrames = frames.filter((f) => f.tag === 'SnapshotConfirmed');
const decommitFrames = frames.filter((f) => f.tag === 'DecommitRequested');

// ---- recorded-snapshot-frames.json: shapes only -----------------------------
const ELIDED = '…';
function shapeOf(value: unknown, keep: Set<string>, depth = 0): unknown {
	if (Array.isArray(value)) return ELIDED;
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			const child = (value as Record<string, unknown>)[key];
			out[key] = depth === 0 && keep.has(key) ? child : shapeOf(child, keep, depth + 1);
		}
		return out;
	}
	return ELIDED;
}
// utxo maps are keyed by tx reference, so their shape is "an object"; elide
// them entirely rather than recording one head's references as field names.
function shapeOfFrame(frame: Frame): Record<string, unknown> {
	const shaped = shapeOf(frame, new Set(['seq', 'tag'])) as Record<string, unknown>;
	const snapshot = shaped.snapshot as Record<string, unknown> | undefined;
	if (snapshot) {
		for (const partition of ['utxo', 'utxoToCommit', 'utxoToDecommit', 'confirmed']) {
			if (partition in snapshot) snapshot[partition] = ELIDED;
		}
	}
	return shaped;
}
const seenShapes = new Map<string, Record<string, unknown>>();
for (const frame of snapshotFrames) {
	const shaped = shapeOfFrame(frame);
	const key = JSON.stringify({ ...shaped, seq: undefined });
	if (!seenShapes.has(key)) seenShapes.set(key, shaped);
}

// ---- recorded-head-history.json: a consecutive window -----------------------
const byNumber = new Map<number, Snapshot>();
for (const frame of snapshotFrames) {
	const raw = frame.snapshot as Record<string, unknown>;
	const number = raw.number as number;
	if (byNumber.has(number)) continue;
	byNumber.set(number, {
		number,
		version: raw.version as number,
		utxo: (raw.utxo as Record<string, unknown>) ?? {},
		utxoToCommit: (raw.utxoToCommit as Record<string, unknown> | null) ?? null,
		utxoToDecommit: (raw.utxoToDecommit as Record<string, unknown> | null) ?? null,
		depositTxId: (raw.depositTxId as string | null | undefined) ?? null,
		confirmed: ((raw.confirmed as Array<{ txId: string; cborHex: string }>) ?? []).map(({ txId, cborHex }) => ({
			txId,
			cborHex,
		})),
	});
}
const numbers = [...byNumber.keys()].sort((a, b) => a - b);
console.log('snapshots in history:', numbers.join(', '));
for (const n of numbers) {
	const s = byNumber.get(n)!;
	console.log(
		`  ${n}: v=${s.version} utxo=${Object.keys(s.utxo).length} toCommit=${s.utxoToCommit ? Object.keys(s.utxoToCommit).length : '-'} toDecommit=${s.utxoToDecommit ? Object.keys(s.utxoToDecommit).length : '-'} deposit=${s.depositTxId ? s.depositTxId.slice(0, 8) : '-'} confirmed=${s.confirmed.length}`,
	);
}
if (!Number.isInteger(from)) {
	console.log('\nno --from given: listed only, nothing written');
	process.exit(0);
}
const window: Snapshot[] = [];
for (let n = from; n < from + count; n++) {
	const s = byNumber.get(n);
	if (!s) {
		console.error(`snapshot ${n} is not in the history; window must be consecutive`);
		process.exit(1);
	}
	window.push(s);
}
const wantedDecommits = new Set(
	window.flatMap((s) => Object.keys(s.utxoToDecommit ?? {}).map((ref) => ref.slice(0, ref.indexOf('#')).toLowerCase())),
);
const decommitTransactions = decommitFrames
	.map((f) => f.decommitTx as { txId: string; cborHex: string })
	.filter((tx) => tx && wantedDecommits.has(tx.txId.toLowerCase()))
	.map(({ txId, cborHex }) => ({ txId, cborHex }));
for (const id of wantedDecommits) {
	if (!decommitTransactions.some((tx) => tx.txId.toLowerCase() === id)) {
		console.error(`window declares decommit ${id} but the history has no DecommitRequested carrying it`);
		process.exit(1);
	}
}

const dir = path.join(process.cwd(), 'src/lib/hydra/hydra/__fixtures__');
fs.writeFileSync(
	path.join(dir, 'recorded-snapshot-frames.json'),
	JSON.stringify(
		{
			description: `Key shape of every SnapshotConfirmed frame a real ${label} emitted. Payloads elided; only the field names are asserted.`,
			frames: [...seenShapes.values()],
		},
		null,
		'\t',
	) + '\n',
);
const summary = window
	.map((s) => {
		const parts: string[] = [];
		if (s.utxoToCommit && Object.keys(s.utxoToCommit).length) parts.push('declares an incremental commit');
		if (s.utxoToDecommit && Object.keys(s.utxoToDecommit).length) parts.push('declares a decommit');
		if (s.confirmed.length) parts.push(`applies ${s.confirmed.length} L2 tx`);
		return `${s.number}: ${parts.join(', ') || 'absorbs the pending item'}`;
	})
	.join('; ');
fs.writeFileSync(
	path.join(dir, historyOut),
	JSON.stringify(
		{
			description: `Recorded ${label} history, snapshots ${from}–${from + count - 1}: ${summary}.`,
			snapshots: window,
			decommitTransactions,
		},
		null,
		'\t',
	) + '\n',
);
console.log(
	`\nwrote recorded-snapshot-frames.json (${seenShapes.size} distinct shape(s)) and ${historyOut} (${window.length} snapshots, ${decommitTransactions.length} decommit tx)`,
);
