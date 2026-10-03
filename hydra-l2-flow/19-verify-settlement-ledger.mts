/**
 * Verify the Milestone 4 settlement ledger against the chain.
 *
 * For every ledger row: Blockfrost must return the transaction with
 * valid_contract=true. For every head: deposits − withdrawals (REQUESTED, i.e.
 * what left the head) − fanout value returned to the purchasing hot wallet
 * must be zero. The settled L1 amount of a withdrawal is smaller than the
 * requested one by the decommit's own L1 fee; it is reported, not summed.
 *
 * Run:      pnpm exec tsx hydra-l2-flow/19-verify-settlement-ledger.mts
 * Selftest: pnpm exec tsx hydra-l2-flow/19-verify-settlement-ledger.mts --selftest
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bf, CARDANOSCAN_TX, EVIDENCE_ROOT, log, readLedger, type LedgerRow } from './m4-lib.mts';

const SETTLEMENT_DIR = join(EVIDENCE_ROOT, 'settlement');
const LEDGER = join(SETTLEMENT_DIR, 'ledger.jsonl');
/** Optional: a prior attempt on a reused head, whose deposits/withdrawals are already inside the counted series' opening balance. readLedger returns [] when absent. */
const CARRIED_LEDGER = join(SETTLEMENT_DIR, 'ledger-attempt1.jsonl');

type TxMeta = { hash: string; block_height: number; block_time: number; valid_contract: boolean; fees: string };
type TxUtxos = { outputs: Array<{ address: string; amount: Array<{ unit: string; quantity: string }> }> };
type CheckedRow = LedgerRow & { block: number | null; validContract: boolean | null; fees: string | null };

/** Pure: lovelace conservation for one head, given what was already in the head (carriedIn) before the counted series began. Exported for the selftest. */
export function conservation(
	rows: LedgerRow[],
	fanoutToWallet: bigint,
	carriedIn = 0n,
): { deposits: bigint; withdrawals: bigint; carriedIn: bigint; delta: bigint } {
	const deposits = rows.filter((r) => r.kind === 'deposit').reduce((sum, r) => sum + BigInt(r.lovelace ?? '0'), 0n);
	const withdrawals = rows.filter((r) => r.kind === 'withdrawal').reduce((sum, r) => sum + BigInt(r.lovelace ?? '0'), 0n);
	return { deposits, withdrawals, carriedIn, delta: deposits + carriedIn - withdrawals - fanoutToWallet };
}

/** Pure: lovelace left in the head by a prior (uncounted) attempt on the same head identifier. Exported for the selftest. */
export function carriedInFor(carriedRows: LedgerRow[], headIdentifier: string): bigint {
	const mine = carriedRows.filter((r) => r.headIdentifier === headIdentifier);
	const deposits = mine.filter((r) => r.kind === 'deposit').reduce((sum, r) => sum + BigInt(r.lovelace ?? '0'), 0n);
	const withdrawals = mine.filter((r) => r.kind === 'withdrawal').reduce((sum, r) => sum + BigInt(r.lovelace ?? '0'), 0n);
	return deposits - withdrawals;
}

/** Pure: txHashes present in both the counted and carried-in ledgers — a structural guard against the same transaction being double-counted into both `conservation()`'s total and `carriedIn`. Exported for the selftest. */
export function overlappingTxHashes(counted: LedgerRow[], carried: LedgerRow[]): string[] {
	const countedHashes = new Set(counted.map((r) => r.txHash));
	return [...new Set(carried.filter((r) => countedHashes.has(r.txHash)).map((r) => r.txHash))];
}

/** Pure: a series is consecutive when its rows are ordered by doneAt and nothing else is interleaved. */
export function isConsecutive(rows: LedgerRow[]): boolean {
	for (let i = 1; i < rows.length; i += 1) if (rows[i].doneAt < rows[i - 1].doneAt) return false;
	return true;
}

function selftest(): void {
	const row = (kind: LedgerRow['kind'], lovelace: string | null, doneAt: string): LedgerRow => ({
		headIndex: 1, headId: 'h', headIdentifier: 'id', kind, txHash: 'x', lovelace, startedAt: doneAt, doneAt,
	});
	// 2 x 10 ADA in, one 8 ADA withdrawal requested (settled 7.83 after its L1 fee), 12 ADA back at fanout.
	const rows = [row('deposit', '10000000', '1'), row('deposit', '10000000', '2'), { ...row('withdrawal', '8000000', '3'), settledLovelace: '7830000' }, row('close', null, '4'), row('fanout', null, '5')];
	assert.deepEqual(conservation(rows, 12000000n), { deposits: 20000000n, withdrawals: 8000000n, carriedIn: 0n, delta: 0n });
	assert.equal(conservation(rows, 11800000n).delta, 200000n);
	// A prior attempt left 20 ADA in the head before this series began: without it the fanout looks 20 ADA short; with it, zero.
	assert.equal(conservation(rows, 32000000n).delta, -20000000n);
	assert.equal(conservation(rows, 32000000n, 20000000n).delta, 0n);
	assert.equal(isConsecutive(rows), true);
	assert.equal(isConsecutive([rows[1], rows[0]]), false);

	const carried = (headIdentifier: string, kind: LedgerRow['kind'], lovelace: string, doneAt: string): LedgerRow => ({
		headIndex: 1, headId: 'h', headIdentifier, kind, txHash: 'x', lovelace, startedAt: doneAt, doneAt,
	});
	const carriedRows = [
		carried('id-a', 'deposit', '40000000', '1'),
		carried('id-a', 'deposit', '40000000', '2'),
		carried('id-a', 'withdrawal', '3500000', '3'),
		carried('id-a', 'withdrawal', '3500000', '4'),
		carried('id-b', 'deposit', '5000000', '5'),
	];
	assert.equal(carriedInFor(carriedRows, 'id-a'), 73000000n);
	assert.equal(carriedInFor(carriedRows, 'id-b'), 5000000n);
	assert.equal(carriedInFor(carriedRows, 'id-c'), 0n);
	assert.equal(carriedInFor([], 'id-a'), 0n);

	const disjointCounted = [{ ...row('deposit', '1000000', '1'), txHash: 'tx-a' }, { ...row('withdrawal', '500000', '2'), txHash: 'tx-b' }];
	const disjointCarried = [{ ...carried('id-a', 'deposit', '2000000', '1'), txHash: 'tx-c' }];
	assert.deepEqual(overlappingTxHashes(disjointCounted, disjointCarried), []);
	const sharedCarried = [{ ...carried('id-a', 'deposit', '2000000', '1'), txHash: 'tx-a' }];
	assert.deepEqual(overlappingTxHashes(disjointCounted, sharedCarried), ['tx-a']);
	console.log('selftest ok');
}

/** Fetch Blockfrost tx metadata for each row and log it. `prefix` distinguishes carried-in rows in the log stream. */
async function verifyRows(rows: LedgerRow[], prefix: string): Promise<CheckedRow[]> {
	const checked: CheckedRow[] = [];
	for (const r of rows) {
		const meta = await bf<TxMeta>(`/txs/${r.txHash}`);
		checked.push({ ...r, block: meta?.block_height ?? null, validContract: meta?.valid_contract ?? null, fees: meta?.fees ?? null });
		log('verify', `${prefix}${r.kind.padEnd(10)} head ${r.headIndex} ${r.txHash.slice(0, 16)}… ${meta ? (meta.valid_contract ? 'valid' : 'INVALID') : 'NOT FOUND'}`);
	}
	return checked;
}

async function main(): Promise<void> {
	if (process.argv.includes('--selftest')) return selftest();
	const rows = readLedger(LEDGER);
	if (rows.length === 0) throw new Error(`no ledger at ${LEDGER}`);
	const walletAddress = process.env.M4_WALLET_ADDRESS;
	if (!walletAddress) throw new Error('set M4_WALLET_ADDRESS to the purchasing hot wallet address (01-wallet.mts prints it)');

	const carriedRows = readLedger(CARRIED_LEDGER);
	const overlap = overlappingTxHashes(rows, carriedRows);
	if (overlap.length > 0) throw new Error(`txHash present in both ${LEDGER} and ${CARRIED_LEDGER}: ${overlap.join(', ')}`);

	const checked = await verifyRows(rows, '');
	const carriedChecked = await verifyRows(carriedRows, 'carried ');

	const heads = [...new Set(rows.map((r) => r.headIndex))].sort((a, b) => a - b);
	const perHead: Array<{ headIndex: number; headIdentifier: string; carriedIn: string; deposits: string; withdrawals: string; fanoutToWallet: string; delta: string; ok: boolean }> = [];
	for (const h of heads) {
		const mine = rows.filter((r) => r.headIndex === h);
		const fanout = mine.find((r) => r.kind === 'fanout');
		if (!fanout) throw new Error(`head ${h} has no fanout row`);
		const utxos = await bf<TxUtxos>(`/txs/${fanout.txHash}/utxos`);
		const toWallet = (utxos?.outputs ?? [])
			.filter((o) => o.address === walletAddress)
			.reduce((sum, o) => sum + BigInt(o.amount.find((a) => a.unit === 'lovelace')?.quantity ?? '0'), 0n);
		const carriedIn = carriedInFor(carriedRows, mine[0].headIdentifier);
		const c = conservation(mine, toWallet, carriedIn);
		perHead.push({ headIndex: h, headIdentifier: mine[0].headIdentifier, carriedIn: c.carriedIn.toString(), deposits: c.deposits.toString(), withdrawals: c.withdrawals.toString(), fanoutToWallet: toWallet.toString(), delta: c.delta.toString(), ok: c.delta === 0n });
	}

	const allValid = checked.every((c) => c.validContract === true);
	const carriedValid = carriedChecked.every((c) => c.validContract === true);
	const allConserved = perHead.every((p) => p.ok);
	const consecutive = isConsecutive(rows);
	const verdict = allValid && allConserved && consecutive && carriedValid;

	writeFileSync(
		join(SETTLEMENT_DIR, 'verification.json'),
		JSON.stringify({ generated: new Date().toISOString(), total: rows.length, allValid, allConserved, consecutive, carriedValid, rows: checked, carried: carriedChecked, perHead }, null, 2),
	);

	const lines: string[] = [];
	lines.push('# Milestone 4: settlement verification (preprod)', '');
	lines.push(`**Generated:** ${new Date().toISOString()} · **Network:** preprod · **hydra-node:** 2.4.1`, '');
	lines.push(`**Result: ${checked.filter((c) => c.validContract).length} of ${rows.length} settlement transactions valid on chain, ${allConserved ? 'all' : 'NOT all'} heads conserve funds, series ${consecutive ? 'is' : 'is NOT'} consecutive.**`, '');
	lines.push('| # | Head | Kind | Tx | Block | Valid |', '|---|---|---|---|---|---|');
	checked.forEach((c, i) => lines.push(`| ${i + 1} | ${c.headIndex} | ${c.kind} | [\`${c.txHash.slice(0, 16)}…\`](${CARDANOSCAN_TX}/${c.txHash}) | ${c.block ?? '—'} | ${c.validContract === true ? 'yes' : 'NO'} |`));
	lines.push('', '## Fund conservation per head (lovelace)', '', '| Head | Head id | Carried in | Deposited | Withdrawn (requested) | Withdrawn (settled on L1) | Fanout to wallet | Delta |', '|---|---|---|---|---|---|---|---|');
	perHead.forEach((p) => {
		const settled = rows.filter((r) => r.headIndex === p.headIndex && r.kind === 'withdrawal').reduce((sum, r) => sum + BigInt(r.settledLovelace ?? '0'), 0n);
		lines.push(`| ${p.headIndex} | \`${p.headIdentifier.slice(0, 16)}…\` | ${p.carriedIn} | ${p.deposits} | ${p.withdrawals} | ${settled} | ${p.fanoutToWallet} | ${p.delta} |`);
	});
	lines.push('', 'Delta is carried-in plus deposited minus requested withdrawals minus fanout-to-wallet and must be zero. Requested minus settled is the decommit transactions\' own L1 fees.');
	if (carriedChecked.length > 0) {
		lines.push(
			'',
			'## Transactions carried into a head (not counted in the series)',
			'',
			"These settlement transactions ran on the same head before the counted series began (a first attempt that stopped at its third withdrawal; the head stayed open and was reused, so the funds they left in the head return in that head's fanout).",
			'',
			'| Head | Kind | Tx | Block | Valid |',
			'|---|---|---|---|---|',
		);
		carriedChecked.forEach((c) => lines.push(`| ${c.headIndex} | ${c.kind} | [\`${c.txHash.slice(0, 16)}…\`](${CARDANOSCAN_TX}/${c.txHash}) | ${c.block ?? '—'} | ${c.validContract === true ? 'yes' : 'NO'} |`));
	}
	lines.push('', 'Every hash above is selected by the head token policy in `head-N/l1-anchors.json`; no L1 address query is involved.');
	writeFileSync(join(SETTLEMENT_DIR, 'SUMMARY.md'), `${lines.join('\n')}\n`);
	log('verify', `SUMMARY.md written — verdict ${verdict ? 'PASS' : 'FAIL'}`);
	process.exit(verdict ? 0 : 1);
}

main().catch((error) => {
	console.error(`[verify] ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
