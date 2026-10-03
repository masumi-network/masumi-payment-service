/**
 * Retry Fanout on a head that is already Closed / ReadyToFanout (skips the
 * Close step in 13-settle.mts). Meant for re-attempting Fanout against an
 * archived persistence dir with a patched hydra-node binary, without
 * re-running the whole settle flow.
 *
 * Fanout submission itself lives in settle-shared.mts (shared with
 * 13-settle.mts): bounded per-attempt timeout, auto-retry on
 * RejectedInputBecauseUnsynced, CommandFailed-with-Idle-state = success.
 *
 * Run: pnpm exec tsx hydra-l2-flow/15-fanout-only.mts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { HydraNode } from '@/lib/hydra/hydra/node';
import { HydraHeadStatus } from '@/generated/prisma/client';
import { fanoutWithRetry, lastTxIdForTag, toWsUrl, waitForStatus } from './settle-shared.mts';

const NODE1 = process.env.NODE1 ?? 'http://127.0.0.1:4001';
const NATIVE_LOG = process.env.NATIVE_LOG ?? '';
const STATE_FILE = process.env.SETTLEMENT_STATE ?? 'hydra-l2-flow/.native-state/fanout-retry.json';
const ATTEMPT_TIMEOUT_MS = Number(process.env.ATTEMPT_TIMEOUT_MS ?? 120000);
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS ?? 20000);
const MAX_TOTAL_WAIT_MS = Number(process.env.MAX_TOTAL_WAIT_MS ?? 30 * 60 * 1000);

function log(m: string): void {
	console.log(`[fanout-only] ${new Date().toISOString().slice(11, 19)} ${m}`);
}

async function main(): Promise<void> {
	const node = new HydraNode({ httpUrl: NODE1 });
	node.connect();
	await new Promise((r) => setTimeout(r, 1500));

	log(`initial status: ${node.status}`);

	if (node.status === HydraHeadStatus.Closed) {
		log('head Closed — waiting for contestation period to elapse (ReadyToFanout)…');
		const ready = await waitForStatus(node, HydraHeadStatus.FanoutPossible, MAX_TOTAL_WAIT_MS);
		if (!ready) {
			log(`ABORT — head did not reach FanoutPossible (status ${node.status}).`);
			process.exit(1);
		}
	}

	if (node.status !== HydraHeadStatus.FanoutPossible) {
		log(`ABORT — head is not at FanoutPossible (status: ${node.status}). Nothing to fan out.`);
		process.exit(1);
	}

	log('ReadyToFanout — fanning out (settling UTxOs to L1)…');
	const result = await fanoutWithRetry(toWsUrl(NODE1), {
		attemptTimeoutMs: ATTEMPT_TIMEOUT_MS,
		retryDelayMs: RETRY_DELAY_MS,
		maxTotalWaitMs: MAX_TOTAL_WAIT_MS,
		log,
	});

	if (result.outcome === 'failed') {
		log(`Fanout CommandFailed: ${result.detail}`);
		process.exit(1);
	}
	if (result.outcome !== 'finalized') {
		log(`ABORT — no definitive response within budget (last: ${result.outcome}).`);
		process.exit(1);
	}

	const fanoutTx = lastTxIdForTag(NATIVE_LOG, 'FanoutTx');
	log(`=== HEAD FINALIZED ===${fanoutTx ? ` — fanout tx ${fanoutTx.slice(0, 16)}…` : ''}`);

	const state = {
		generated: new Date().toISOString(),
		node: NODE1,
		fanoutTx: fanoutTx || null,
		finalStatus: 'Final',
		nativeLog: NATIVE_LOG || null,
	};
	mkdirSync(dirname(STATE_FILE), { recursive: true });
	writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
	log(`fanout-retry state -> ${STATE_FILE}`);
	process.exit(0);
}

main().catch((e) => {
	console.error('[fanout-only] FATAL', e);
	process.exit(1);
});
