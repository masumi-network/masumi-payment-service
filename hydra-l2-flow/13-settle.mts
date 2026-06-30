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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { HydraNode } from '@/lib/hydra/hydra/node';
import { HydraHeadStatus } from '@/generated/prisma/client';

const NODE1 = process.env.NODE1 ?? 'http://127.0.0.1:4001';
const NATIVE_LOG = process.env.NATIVE_LOG ?? '';
// Settlement facts are written as machine-readable state; build-evidence.cjs folds
// them into the combined EVIDENCE.md so escrow proof + settlement live in one file.
const STATE_FILE = process.env.SETTLEMENT_STATE ?? 'hydra-l2-flow/.native-state/settlement.json';
const FANOUT_WAIT_MS = 30000; // contestation is 3s; 30s covers it with wide margin

function log(m: string): void {
	console.log(`[settle] ${new Date().toISOString().slice(11, 19)} ${m}`);
}

// Best-effort: pull the most recent L1 tx id the node posted for a given tag
// (e.g. CloseTx / FanoutTx) out of the native node log. Returns '' if unknown.
function lastTxIdForTag(tag: string): string {
	if (!NATIVE_LOG || !existsSync(NATIVE_LOG)) return '';
	const lines = readFileSync(NATIVE_LOG, 'utf-8').split('\n');
	for (let i = lines.length - 1; i >= 0; i--) {
		if (lines[i].includes(tag)) {
			const m = lines[i].match(/"transactionId":"([0-9a-f]{64})"/) ?? lines[i].match(/"txId":"([0-9a-f]{64})"/);
			if (m) return m[1];
		}
	}
	return '';
}

async function waitForStatus(node: HydraNode, target: HydraHeadStatus, timeoutMs: number): Promise<boolean> {
	const start = Date.now();
	while (node.status !== target) {
		if (Date.now() - start > timeoutMs) return false;
		await new Promise((r) => setTimeout(r, 500));
	}
	return true;
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
	const closeTx = lastTxIdForTag('CloseTx');
	log(`HeadIsClosed (status ${node.status})${closeTx ? ` — close tx ${closeTx.slice(0, 16)}…` : ''}`);

	// 3. Wait out the contestation period until the node signals ReadyToFanout.
	log('waiting for contestation period to elapse (ReadyToFanout)…');
	const ready = await waitForStatus(node, HydraHeadStatus.FanoutPossible, FANOUT_WAIT_MS);
	if (!ready) {
		log(`ABORT — head did not reach FanoutPossible within ${FANOUT_WAIT_MS / 1000}s (status ${node.status}).`);
		process.exit(1);
	}
	log('ReadyToFanout');

	// 4. Fanout: distribute the head's final UTxOs back onto L1.
	log('fanning out (settling UTxOs to L1)…');
	try {
		await node.fanout();
	} catch (e) {
		log(`Fanout failed: ${e instanceof Error ? e.message : String(e)}`);
		process.exit(1);
	}
	const fanoutTx = lastTxIdForTag('FanoutTx');
	log(`=== HEAD FINALIZED === (status ${node.status})${fanoutTx ? ` — fanout tx ${fanoutTx.slice(0, 16)}…` : ''}`);

	// 5. Persist settlement facts as state for build-evidence.cjs to render into
	//    the combined EVIDENCE.md.
	const state = {
		generated: new Date().toISOString(),
		node: NODE1,
		network: 'local devnet (testnet-magic 42)',
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
