import { config } from './demo-config';
import { SLOT_CONFIG_NETWORK, slotToBeginUnixTime } from '@meshsdk/core';
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

import {
	ada,
	blockfrost,
	DECISIONS_FILE,
	EVENTS_FILE,
	EVIDENCE_DIR,
	log,
	NETWORK,
	reconcileApprovedRuns,
	type ChainTx,
	type DemoState,
	type RunRecord,
} from './demo-context.mjs';
function stats(values: number[]): { n: number; min: number; median: number; max: number } | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return {
		n: sorted.length,
		min: sorted[0],
		median: sorted[Math.floor(sorted.length / 2)],
		max: sorted[sorted.length - 1],
	};
}

function ratio(numerator: bigint, denominator: bigint): string {
	return denominator === 0n ? 'n/a' : (Number(numerator) / Number(denominator)).toFixed(6);
}

type ChainDetail = {
	invalidHereafterMs: number | null;
	scriptFeeLovelace: bigint;
	unitMem: bigint;
	unitSteps: bigint;
};

/** On-chain facts the report needs beyond ChainTx: the script fee Blockfrost records per redeemer, and the validity end. */
async function chainDetail(txHash: string): Promise<ChainDetail> {
	const [tx, redeemers] = await Promise.all([blockfrost.txs(txHash), blockfrost.txsRedeemers(txHash)]);
	const slot = tx.invalid_hereafter == null ? null : Number(tx.invalid_hereafter);
	return {
		invalidHereafterMs: slot == null ? null : slotToBeginUnixTime(slot, SLOT_CONFIG_NETWORK[NETWORK]),
		scriptFeeLovelace: redeemers.reduce((sum, redeemer) => sum + BigInt(redeemer.fee), 0n),
		unitMem: redeemers.reduce((sum, redeemer) => sum + BigInt(redeemer.unit_mem), 0n),
		unitSteps: redeemers.reduce((sum, redeemer) => sum + BigInt(redeemer.unit_steps), 0n),
	};
}

export async function report(state: DemoState): Promise<void> {
	if (state.wallet?.status === 'live') await reconcileApprovedRuns(state);
	const batched = state.runs.find((run) => run.kind === 'allow-batched' && run.submitted && run.chain);
	const singles = state.runs.filter((run) => run.kind === 'allow-single' && run.submitted && run.chain);
	const denials = state.runs.filter((run) => run.decision === 'denied');
	if (batched?.chain == null) throw new Error('no confirmed allow-batched run to report');
	const sameSet = batched.purchaseIndexes.every((index) => singles.some((run) => run.purchaseIndexes[0] === index));
	if (!sameSet || singles.length !== batched.purchaseIndexes.length) {
		throw new Error('allow-single has not locked every purchase of the batched run yet');
	}
	const allowRuns = [batched, ...singles];
	const chainOf = (run: RunRecord): ChainTx => {
		if (run.chain == null) throw new Error(`run ${run.txHash} has no chain record`);
		return run.chain;
	};
	const failed = allowRuns.filter((run) => !chainOf(run).validContract);
	if (failed.length > 0) {
		throw new Error(`phase-2 failure recorded for ${failed.map((run) => run.txHash).join(', ')}`);
	}
	const details = new Map<string, ChainDetail>();
	for (const run of allowRuns) details.set(run.txHash, await chainDetail(run.txHash));
	const detailOf = (run: RunRecord): ChainDetail => {
		const detail = details.get(run.txHash);
		if (detail == null) throw new Error(`missing chain detail for ${run.txHash}`);
		return detail;
	};

	const paymentValue = BigInt(batched.paymentValueLovelace);
	const lockCount = BigInt(batched.purchaseIndexes.length);
	const feeSide = (runs: RunRecord[]) => {
		const fee = runs.reduce((sum, run) => sum + BigInt(chainOf(run).feeLovelace), 0n);
		const scriptFee = runs.reduce((sum, run) => sum + detailOf(run).scriptFeeLovelace, 0n);
		return {
			txs: runs.length,
			locks: runs.reduce((sum, run) => sum + run.purchaseIndexes.length, 0),
			txHashes: runs.map((run) => run.txHash),
			paymentValueLovelace: paymentValue.toString(),
			feeLovelace: fee.toString(),
			scriptFeeLovelace: scriptFee.toString(),
			sizeFeeLovelace: (fee - scriptFee).toString(),
			feePerLockLovelace: (fee / lockCount).toString(),
			feeToPaymentValue: ratio(fee, paymentValue),
			scriptFeeToPaymentValue: ratio(scriptFee, paymentValue),
			sizeBytes: runs.map((run) => chainOf(run).sizeBytes),
			exUnits: runs.map((run) => ({
				mem: detailOf(run).unitMem.toString(),
				steps: detailOf(run).unitSteps.toString(),
			})),
		};
	};
	const batchedFees = feeSide([batched]);
	const singleFees = feeSide(singles);

	// Runs recovered by reconcile after a crash have no in-process timings; leave them out rather than count zero.
	const timing = (pick: (run: RunRecord) => number | undefined) =>
		stats(
			allowRuns.flatMap((run) => {
				const value = pick(run);
				return value == null || run.timings.freezeToSubmitMs == null ? [] : [value];
			}),
		);

	const blockMs = (run: RunRecord) => chainOf(run).blockTime * 1000;
	const windowStart = Math.min(...state.runs.map((run) => Date.parse(run.frozenAt)));
	const windowEnd = Math.max(...allowRuns.map(blockMs));
	const windowMinutes = (windowEnd - windowStart) / 60_000;
	const locksSubmitted = allowRuns.reduce((sum, run) => sum + run.purchaseIndexes.length, 0);
	const singleStart = Math.min(...singles.map((run) => Date.parse(run.frozenAt)));
	const singleEnd = Math.max(...singles.map(blockMs));
	const singleMinutes = (singleEnd - singleStart) / 60_000;
	const singleBlocks = singles.map(blockMs).sort((a, b) => a - b);
	const secondsBetweenSingleConfirmations = singleBlocks.slice(1).map((ms, index) => (ms - singleBlocks[index]) / 1000);
	const overallRate = +(locksSubmitted / windowMinutes).toFixed(3);
	const singleRate = +(singles.length / singleMinutes).toFixed(3);

	const result = {
		ticket: 'MAS-596',
		generatedAt: new Date().toISOString(),
		network: NETWORK,
		cosigner:
			config.cosignUrl == null
				? 'in-process mock (scripts/smart-wallet-demo/cosign-mock.ts)'
				: new URL(config.cosignUrl).origin,
		wallet: { ...state.wallet, quorum: `${state.threshold} of ${state.quorumVkhs.length}` },
		fees: {
			method:
				'Blockfrost after confirmation: txs(hash).fees for the fee, txs(hash)/redeemers fee for the script part; size fee = fee − script fee. Never the builder estimate.',
			batched: batchedFees,
			single: singleFees,
			singleOverBatched: ratio(BigInt(singleFees.feeLovelace), BigInt(batchedFees.feeLovelace)),
		},
		latency: {
			method:
				'performance.now(): freeze = second-pass complete() returned; submit = submitTx returned. freezeToValidityEnd uses the on-chain invalid_hereafter slot.',
			cosigner: 'Round trips are to the local mock, including its Blockfrost lookup of the wallet input.',
			freezeToSubmitMs: timing((run) => run.timings.freezeToSubmitMs),
			cosignRoundTripMs: timing((run) => run.timings.cosignRoundTripMs),
			mergeAndSignMs: timing((run) => run.timings.mergeAndSignMs),
			buildMs: timing((run) => run.timings.buildMs),
			freezeToValidityEndMs: stats(
				allowRuns.flatMap((run) => {
					const end = detailOf(run).invalidHereafterMs;
					return end == null ? [] : [end - Date.parse(run.frozenAt)];
				}),
			),
			denials: denials.map((run) => ({
				txHash: run.txHash,
				decisionId: run.decisionId,
				code: run.denialCode,
				deniedPurchaseIds: run.deniedPurchaseIds,
				deniedCodes: run.deniedCodes,
				freezeToDecisionMs: run.timings.freezeToDecisionMs,
			})),
		},
		volume: {
			note: 'Observed on one demo node over the real demo window. Not extrapolated to a sustained or network-wide rate.',
			window: {
				from: new Date(windowStart).toISOString(),
				to: new Date(windowEnd).toISOString(),
				minutes: +windowMinutes.toFixed(2),
			},
			locksSubmitted,
			txsSubmitted: allowRuns.length,
			txsDenied: denials.length,
			locksPerMinuteOverWindow: overallRate,
			batchedPhase: {
				locks: batched.purchaseIndexes.length,
				txs: 1,
				freezeToBlockSeconds: +((blockMs(batched) - Date.parse(batched.frozenAt)) / 1000).toFixed(1),
			},
			singleItemPhase: {
				locks: singles.length,
				txs: singles.length,
				minutes: +singleMinutes.toFixed(2),
				locksPerMinute: singleRate,
				secondsBetweenConfirmations: stats(secondsBetweenSingleConfirmations),
			},
			locksPerMinuteRange: [Math.min(overallRate, singleRate), Math.max(overallRate, singleRate)],
		},
		runs: state.runs,
	};

	const outDir = path.join(EVIDENCE_DIR, result.generatedAt.replace(/[:.]/g, '-'));
	fs.mkdirSync(outDir, { recursive: true });
	fs.writeFileSync(path.join(outDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
	if (fs.existsSync(EVENTS_FILE)) fs.copyFileSync(EVENTS_FILE, path.join(outDir, 'events.ndjson'));
	if (fs.existsSync(DECISIONS_FILE)) fs.copyFileSync(DECISIONS_FILE, path.join(outDir, 'cosign-decisions.ndjson'));
	const f = result.fees;
	const l = result.latency;
	const v = result.volume;
	const statRow = (label: string, s: ReturnType<typeof stats>) =>
		`| ${label} | ${s?.n ?? 0} | ${s?.min ?? '-'} | ${s?.median ?? '-'} | ${s?.max ?? '-'} |`;
	fs.writeFileSync(
		path.join(outDir, 'SUMMARY.md'),
		[
			`# MAS-596 guarded smart-wallet demo — ${NETWORK} — ${result.generatedAt}`,
			'',
			'| Measure | Batched | Single-item |',
			'| --- | --- | --- |',
			`| Locks | ${f.batched.locks} in ${f.batched.txs} tx | ${f.single.locks} in ${f.single.txs} txs |`,
			`| Payment value | ${ada(f.batched.paymentValueLovelace)} | ${ada(f.single.paymentValueLovelace)} |`,
			`| Fee (on chain) | ${ada(f.batched.feeLovelace)} | ${ada(f.single.feeLovelace)} |`,
			`| of which script fee | ${ada(f.batched.scriptFeeLovelace)} | ${ada(f.single.scriptFeeLovelace)} |`,
			`| of which size fee | ${ada(f.batched.sizeFeeLovelace)} | ${ada(f.single.sizeFeeLovelace)} |`,
			`| Fee per lock | ${ada(f.batched.feePerLockLovelace)} | ${ada(f.single.feePerLockLovelace)} |`,
			`| Fee / payment value | ${f.batched.feeToPaymentValue} | ${f.single.feeToPaymentValue} |`,
			`| Script fee / payment value | ${f.batched.scriptFeeToPaymentValue} | ${f.single.scriptFeeToPaymentValue} |`,
			'',
			`Single-item fees are ${f.singleOverBatched}× the batched fee.`,
			'',
			'| Latency (ms) | n | min | median | max |',
			'| --- | --- | --- | --- | --- |',
			statRow('freeze → submit', l.freezeToSubmitMs),
			statRow('co-sign round trip', l.cosignRoundTripMs),
			statRow('merge + agent sign', l.mergeAndSignMs),
			statRow('build (to freeze)', l.buildMs),
			statRow('freeze → validity end', l.freezeToValidityEndMs),
			'',
			`Denials: ${l.denials.map((d) => `${d.code} (${d.deniedCodes?.join(', ') || '-'} on ${d.deniedPurchaseIds?.join(', ') || '-'}, freeze → decision ${d.freezeToDecisionMs} ms)`).join('; ') || 'none'}`,
			'',
			`Observed volume on one node: ${v.locksSubmitted} locks in ${v.txsSubmitted} txs, ${v.txsDenied} denied, over ${v.window.minutes} min. Single-item phase ${v.singleItemPhase.locksPerMinute} locks/min, whole window ${v.locksPerMinuteOverWindow} locks/min. Not extrapolated.`,
			'',
		].join('\n'),
	);
	log(`evidence written to ${outDir}`);
	log(
		`batched fee ${ada(f.batched.feeLovelace)} (${f.batched.feeToPaymentValue} of value) vs single ${ada(f.single.feeLovelace)} (${f.single.feeToPaymentValue})`,
	);
}
