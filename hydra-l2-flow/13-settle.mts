/**
 * Settle the head: Close → (contestation) → Fanout, landing the in-head UTxOs
 * back on Cardano L1. This is the L2→L1 settlement phase and is meant to run
 * LAST, after all escrow flows — Close is terminal, the head cannot be reused.
 *
 * It imports nothing from the escrow step drivers. It writes settlement facts to
 * a JSON state file which build-evidence.cjs folds into the combined EVIDENCE.md
 * (escrow proof + settlement in one report).
 *
 * Run: pnpm exec tsx hydra-l2-flow/13-settle.mts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { HydraNode } from '@/lib/hydra/hydra/node';
import { HydraHeadStatus } from '@/generated/prisma/client';
import { fanoutWithRetry, lastTxIdForTag, toWsUrl, waitForStatus } from './settle-shared.mts';

const NODE1 = process.env.NODE1 ?? 'http://127.0.0.1:4001';
const NATIVE_LOG = process.env.NATIVE_LOG ?? '';
const NETWORK = process.env.HYDRA_FLOW_NETWORK ?? 'devnet';
// Settlement facts are written as machine-readable state; build-evidence.cjs folds
// them into the combined EVIDENCE.md so escrow proof + settlement live in one file.
const STATE_FILE = process.env.SETTLEMENT_STATE ?? 'hydra-l2-flow/.native-state/settlement.json';
// Must exceed the node's --contestation-period (devnet 3s; preprod 220s, see
// hydra-native.sh) before ReadyToFanout is reached, plus margin for the node's own
// observed chain-time to catch up to the deadline. A value tuned for devnet's 3s CP
// (previously a flat 30s) unconditionally times out on preprod's much longer CP.
// Also reused as the total budget for the fanout retry loop below — the caller's
// RUN_TIMEOUT must therefore cover ~2x this value (see cmd_settle).
const FANOUT_WAIT_MS = Number(process.env.FANOUT_WAIT_MS ?? (NETWORK === 'preprod' ? 300000 : 30000));

function log(m: string): void {
	console.log(`[settle] ${new Date().toISOString().slice(11, 19)} ${m}`);
}

async function main(): Promise<void> {
	const node = new HydraNode({ httpUrl: NODE1 });
	node.connect();
	// Greetings (sent on connect) carries the current headStatus → populates node.status.
	await new Promise((r) => setTimeout(r, 1500));

	if (node.status !== HydraHeadStatus.Open) {
		log(`ABORT — head is not Open (status: ${node.status}). Settlement only runs on an open head.`);
		process.exit(1);
	}

	// 1. Snapshot the in-head UTxO set that is about to be settled to L1.
	const pre = await node.snapshotUTxO();
	const totalLovelace = pre.reduce(
		(sum, u) => sum + BigInt(u.output.amount.find((a) => a.unit === 'lovelace')?.quantity ?? '0'),
		0n,
	);
	log(`head Open — ${pre.length} in-head UTxO(s), ${totalLovelace} lovelace to settle`);

	// 2. Close: posts the latest signed snapshot to L1, starts the contestation window.
	log('closing head (posting final snapshot to L1)…');
	try {
		await node.close();
	} catch (e) {
		log(`Close failed: ${e instanceof Error ? e.message : String(e)}`);
		log('(if this is PPViewHashesDontMatch, re-run align-cost-models on all nodes)');
		process.exit(1);
	}
	const closeTx = lastTxIdForTag(NATIVE_LOG, 'CloseTx');
	log(`HeadIsClosed (status ${node.status})${closeTx ? ` — close tx ${closeTx.slice(0, 16)}…` : ''}`);

	// 3. Wait out the contestation period until the node signals ReadyToFanout.
	log('waiting for contestation period to elapse (ReadyToFanout)…');
	const ready = await waitForStatus(node, HydraHeadStatus.FanoutPossible, FANOUT_WAIT_MS);
	if (!ready) {
		log(`ABORT — head did not reach FanoutPossible within ${FANOUT_WAIT_MS / 1000}s (status ${node.status}).`);
		process.exit(1);
	}
	log('ReadyToFanout');

	// 4. Fanout: distribute the head's final UTxOs back onto L1. Uses the robust
	//    raw-WS submitter (settle-shared.mts) instead of node.fanout(): bounded
	//    per-attempt timeout, auto-retry on RejectedInputBecauseUnsynced, and
	//    CommandFailed-with-Idle-state counts as success (already finalized).
	log('fanning out (settling UTxOs to L1)…');
	const result = await fanoutWithRetry(toWsUrl(NODE1), {
		maxTotalWaitMs: FANOUT_WAIT_MS,
		log,
	});
	if (result.outcome === 'failed') {
		log(`Fanout failed: ${result.detail}`);
		process.exit(1);
	}
	if (result.outcome !== 'finalized') {
		log(`Fanout gave no definitive result within ${FANOUT_WAIT_MS / 1000}s (last: ${result.outcome}).`);
		process.exit(1);
	}
	const fanoutTx = lastTxIdForTag(NATIVE_LOG, 'FanoutTx');
	log(`=== HEAD FINALIZED === (status ${node.status})${fanoutTx ? ` — fanout tx ${fanoutTx.slice(0, 16)}…` : ''}`);

	// 5. Persist settlement facts as state for build-evidence.cjs to render into
	//    the combined EVIDENCE.md.
	const state = {
		generated: new Date().toISOString(),
		node: NODE1,
		network:
			process.env.HYDRA_FLOW_NETWORK === 'preprod' ? 'Cardano preprod (blockfrost)' : 'local devnet (testnet-magic 42)',
		preCloseUtxoCount: pre.length,
		totalLovelaceSettled: totalLovelace.toString(),
		closeTx: closeTx || null,
		fanoutTx: fanoutTx || null,
		finalStatus: node.status,
		nativeLog: NATIVE_LOG || null,
		utxos: pre.map((u) => ({
			ref: `${u.input.txHash}#${u.input.outputIndex}`,
			lovelace: u.output.amount.find((a) => a.unit === 'lovelace')?.quantity ?? '0',
			address: u.output.address,
		})),
	};
	mkdirSync(dirname(STATE_FILE), { recursive: true });
	writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
	log(`settlement state → ${STATE_FILE} (run 'evidence' to render the combined report)`);
	process.exit(0);
}

main().catch((e) => {
	console.error('[settle] FATAL', e);
	process.exit(1);
});
