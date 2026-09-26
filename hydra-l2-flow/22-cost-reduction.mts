/**
 * Cost reduction, computed from the chain rather than asserted.
 *
 *   baseline  = fee of one real L1 escrow lock we produced (Task 5, forceLayer L1)
 *   l2 per tx = (sum of L1 fees of a head's lifecycle: init, increments, decrements, close, fanout) / (L2 txs the head carried)
 *   reduction = 1 − l2PerTx / baseline
 *
 * In-head transactions themselves pay zero fee (the service forces fee 0), so
 * the only L2 cost is the amortised head lifecycle.
 *
 * Run:      pnpm exec tsx hydra-l2-flow/22-cost-reduction.mts --head-dir hydra-l2-flow/evidence/2026-m4-preprod/settlement/head-1 --l2-txs <count>
 * Selftest: pnpm exec tsx hydra-l2-flow/22-cost-reduction.mts --selftest
 */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bf, EVIDENCE_ROOT, log } from './m4-lib.mts';

const arg = (name: string): string | undefined => {
	const i = process.argv.indexOf(name);
	return i > -1 ? process.argv[i + 1] : undefined;
};

export function reduction(headLifecycleFees: bigint, l2TxCount: bigint, baselineFeePerTx: bigint): { l2PerTx: bigint; reductionPct: number } {
	if (l2TxCount <= 0n || baselineFeePerTx <= 0n) throw new Error('counts and baseline must be positive');
	const l2PerTx = headLifecycleFees / l2TxCount;
	return { l2PerTx, reductionPct: Number(((baselineFeePerTx - l2PerTx) * 10_000n) / baselineFeePerTx) / 100 };
}

function selftest(): void {
	assert.deepEqual(reduction(5_000_000n, 1_000n, 200_000n), { l2PerTx: 5_000n, reductionPct: 97.5 });
	assert.deepEqual(reduction(4_000_000n, 10_000n, 180_000n), { l2PerTx: 400n, reductionPct: 99.77 });
	assert.throws(() => reduction(1n, 0n, 1n));
	console.log('selftest ok');
}

async function main(): Promise<void> {
	if (process.argv.includes('--selftest')) return selftest();
	const headDir = arg('--head-dir');
	const l2Txs = BigInt(arg('--l2-txs') ?? '0');
	if (!headDir || l2Txs <= 0n) throw new Error('usage: --head-dir <dir with l1-anchors.json> --l2-txs <count>');
	const anchors = JSON.parse(readFileSync(join(headDir, 'l1-anchors.json'), 'utf8')) as { anchors: Array<{ role: string; txHash: string }> };
	let lifecycleFees = 0n;
	for (const a of anchors.anchors) {
		if (a.role === 'funding') continue; // the wallet split is not part of the head's cost
		const meta = await bf<{ fees: string }>(`/txs/${a.txHash}`);
		if (!meta) throw new Error(`anchor ${a.role} ${a.txHash} not found on chain`);
		lifecycleFees += BigInt(meta.fees);
		log('cost', `${a.role.padEnd(9)} fee ${meta.fees} lovelace`);
	}
	const baselineHash = readFileSync(join(process.cwd(), 'hydra-l2-flow', '.native-state', 'm4-l1-lock-tx.txt'), 'utf8').trim();
	const baseline = await bf<{ fees: string }>(`/txs/${baselineHash}`);
	if (!baseline) throw new Error(`baseline L1 lock ${baselineHash} not found on chain`);
	const r = reduction(lifecycleFees, l2Txs, BigInt(baseline.fees));

	mkdirSync(join(EVIDENCE_ROOT, 'perf'), { recursive: true });
	const md = [
		'# Milestone 4: transaction cost reduction (preprod)', '',
		`| Quantity | Value |`, `|---|---|`,
		`| Baseline: fee of one real L1 escrow lock (\`${baselineHash.slice(0, 16)}…\`) | ${baseline.fees} lovelace |`,
		`| Head lifecycle L1 fees (init + increments + decrements + close + fanout) | ${lifecycleFees} lovelace |`,
		`| L2 transactions carried by that head | ${l2Txs} |`,
		`| Amortised L1 cost per L2 transaction | ${r.l2PerTx} lovelace |`,
		`| In-head fee per L2 transaction | 0 lovelace (fee forced to zero) |`,
		`| **Cost reduction** | **${r.reductionPct} %** |`, '',
		'Fees are read from Blockfrost for each hash; nothing is estimated.',
	];
	writeFileSync(join(EVIDENCE_ROOT, 'perf', 'COST.md'), `${md.join('\n')}\n`);
	log('cost', `reduction ${r.reductionPct}% — COST.md written`);
	process.exit(r.reductionPct >= 95 ? 0 : 1);
}

main().catch((error) => {
	console.error(`[cost] ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
