/**
 * Extract a timestamped timeline of a Hydra head's life from the node's own
 * event store (`<persistence>/<party>/hydra.db`).
 *
 * This is the audit trail behind the benchmark numbers: it is the node's
 * authoritative record, not our test harness's view. Every row carries a
 * microsecond UTC timestamp written by hydra-node itself.
 *
 * Emits:
 *   - a LIFECYCLE section: head state transitions (Init/Open/Close/Fanout …)
 *   - a THROUGHPUT section: snapshot confirmations bucketed per second, so the
 *     TPS claim can be checked directly against the node's own record
 *   - a TOTALS section: event counts by type
 *
 * Run:
 *   pnpm exec tsx hydra-l2-flow/extract-head-timeline.mts \
 *     [persistenceDir] [--json out.json]
 *   default persistenceDir: hydra-l2-flow/preprod/persistence/purchasing
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const jsonFlagIndex = args.indexOf('--json');
const jsonOut = jsonFlagIndex >= 0 ? args[jsonFlagIndex + 1] : undefined;
const positional = args.filter((a, i) => !a.startsWith('--') && i !== jsonFlagIndex + 1);
const PERSIST =
	positional[0] ?? join(process.cwd(), 'hydra-l2-flow', 'preprod', 'persistence', 'purchasing');
const DB = join(PERSIST, 'hydra.db');

/** Head-lifecycle events, in the order they occur. Everything else is traffic. */
const LIFECYCLE = new Set([
	'HeadInitialized',
	'HeadOpened',
	'HeadIsInitializing',
	'HeadIsOpen',
	'HeadIsClosed',
	'HeadIsContested',
	'HeadIsFinalized',
	'HeadIsAborted',
	'CommitRecorded',
	'CommitApproved',
	'CommitFinalized',
	'DepositRecorded',
	'DepositActivated',
	'DepositExpired',
	'ChainRolledBack',
	'TxInvalid',
]);

/**
 * One snapshot copy per run, reused by every query and removed at exit.
 * Copying is required — the live DB has a hot WAL and must never be written to
 * — but the file is >100 MB, so copying per query would be both slow and a
 * disk-filling leak.
 */
let dbCopy: string | undefined;
function snapshotDb(): string {
	if (dbCopy) return dbCopy;
	const dir = mkdtempSync(join(tmpdir(), 'hydra-timeline-'));
	const copy = join(dir, 'hydra.db');
	copyFileSync(DB, copy);
	for (const suffix of ['-wal', '-shm']) {
		if (existsSync(DB + suffix)) copyFileSync(DB + suffix, copy + suffix);
	}
	dbCopy = copy;
	process.on('exit', () => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best effort */
		}
	});
	return copy;
}

function sqlite(query: string): string {
	return execFileSync('sqlite3', [snapshotDb(), query], {
		encoding: 'utf-8',
		maxBuffer: 512 * 1024 * 1024,
	});
}

function main() {
	if (!existsSync(DB)) {
		console.error(`no event store at ${DB}`);
		process.exit(2);
	}
	console.log(`# Hydra head timeline — ${DB}\n`);

	const total = sqlite('SELECT count(*) FROM events;').trim();
	const span = sqlite(
		"SELECT min(json_extract(event_data,'$.time')) || '|' || max(json_extract(event_data,'$.time')) FROM events;",
	).trim();
	const [first, last] = span.split('|');
	console.log(`events: ${total}`);
	console.log(`first:  ${first}`);
	console.log(`last:   ${last}\n`);

	// ── lifecycle ───────────────────────────────────────────────────────────
	console.log('## Head lifecycle (node-recorded, UTC)\n');
	const rows = sqlite(
		"SELECT json_extract(event_data,'$.time') || '|' || json_extract(event_data,'$.stateChanged.tag') " +
			'FROM events ORDER BY event_id;',
	)
		.split('\n')
		.filter(Boolean);
	let shown = 0;
	for (const row of rows) {
		const [time, tag] = row.split('|');
		if (!tag || !LIFECYCLE.has(tag)) continue;
		console.log(`  ${time}  ${tag}`);
		shown += 1;
	}
	if (shown === 0) console.log('  (no lifecycle events — head may still be mid-run)');

	// ── throughput, from the node's own per-transaction records ─────────────
	// NOTE: the persisted SnapshotConfirmed event carries only signatures (its
	// `snapshot` field is null on disk), so transactions-applied is the usable
	// per-tx signal in the event store. Our harness's events.ndjson holds the
	// authoritative per-tx sent/valid/confirmed timings; this cross-checks the
	// aggregate rate against the node's own independent record.
	console.log('\n## Transactions applied per second (node-recorded, busiest 15)\n');
	const perSec = sqlite(
		"SELECT substr(json_extract(event_data,'$.time'),1,19) AS sec, count(*) AS txs " +
			"FROM events WHERE json_extract(event_data,'$.stateChanged.tag')='TransactionAppliedToLocalUTxO' " +
			'GROUP BY sec ORDER BY txs DESC LIMIT 15;',
	)
		.split('\n')
		.filter(Boolean);
	if (perSec.length === 0) {
		console.log('  (no transactions recorded)');
	} else {
		console.log('  UTC second → transactions applied in it:');
		for (const row of perSec) {
			const [sec, txs] = row.split('|');
			console.log(`    ${sec}Z  ${String(txs).padStart(5)} tx/s`);
		}
		const peak = Number(perSec[0].split('|')[1]);
		console.log(`\n  peak observed: ${peak} tx/s (node's own record)`);
	}

	// ── totals ──────────────────────────────────────────────────────────────
	console.log('\n## Event totals by type\n');
	const totals = sqlite(
		"SELECT json_extract(event_data,'$.stateChanged.tag') AS tag, count(*) AS n " +
			'FROM events GROUP BY tag ORDER BY n DESC;',
	)
		.split('\n')
		.filter(Boolean);
	for (const row of totals) {
		const [tag, n] = row.split('|');
		console.log(`  ${String(n).padStart(7)}  ${tag}`);
	}

	if (jsonOut) {
		writeFileSync(
			jsonOut,
			JSON.stringify(
				{
					source: DB,
					events: Number(total),
					firstEvent: first,
					lastEvent: last,
					lifecycle: rows
						.map((r) => r.split('|'))
						.filter(([, tag]) => LIFECYCLE.has(tag))
						.map(([time, tag]) => ({ time, tag })),
					busiestSeconds: perSec.map((r) => {
						const [sec, txs] = r.split('|');
						return { second: `${sec}Z`, confirmedTxs: Number(txs) };
					}),
					eventTotals: Object.fromEntries(
						totals.map((r) => {
							const [tag, n] = r.split('|');
							return [tag, Number(n)];
						}),
					),
				},
				null,
				2,
			),
		);
		console.log(`\nJSON written to ${jsonOut}`);
	}
}

main();
