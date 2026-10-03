/**
 * Close the head and fan it out, then report how many L1 transactions the
 * fanout actually took.
 *
 * Drives the node directly rather than through the payment service, so it works
 * on a devnet where there is no Blockfrost and no seeded database. The point is
 * the shape of the result: with more UTxOs than fit in one transaction,
 * hydra-node 2.2.0+ distributes them over several PartialFanoutTx steps and a
 * final FinalPartialFanoutTx that burns the head tokens.
 *
 * Run: pnpm exec tsx hydra-l2-flow/91-close-fanout.mts
 */
import { writeFileSync } from 'node:fs';
import { HydraNode } from '@/lib/hydra/hydra/node';
import { HydraHeadStatus } from '@/generated/prisma/client';

const NODE1 = process.env.NODE1 ?? 'http://127.0.0.1:4001';
const OUT = process.env.FANOUT_OUT ?? 'hydra-l2-flow/.native-state/fanout-result.json';

function log(m: string) {
	console.log(`[close-fanout] ${new Date().toISOString().slice(11, 19)} ${m}`);
}

async function waitFor(node: HydraNode, want: HydraHeadStatus, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (node.status === want) return true;
		await new Promise((r) => setTimeout(r, 1000));
	}
	return false;
}

async function main() {
	const node = new HydraNode({ httpUrl: NODE1 });
	node.connect();
	await new Promise((r) => setTimeout(r, 2000));

	const before = await node.snapshotUTxO();
	log(`head holds ${before.length} UTxOs, status ${node.status}`);

	if (node.status === HydraHeadStatus.Open) {
		log('closing…');
		await node.close().catch((error: unknown) => log(`close returned: ${(error as Error).message}`));
	}
	log(`status ${node.status}; waiting for the contestation deadline…`);
	if (!(await waitFor(node, HydraHeadStatus.FanoutPossible, 20 * 60 * 1000))) {
		throw new Error(`head never became fanout-possible (status ${node.status})`);
	}

	// Partial fanout needs one Fanout command per step: each distributes what it
	// can and leaves the head in FanoutProgress for the next.
	let steps = 0;
	while (node.status !== HydraHeadStatus.Final && steps < 32) {
		steps += 1;
		log(`fanout attempt ${steps} (status ${node.status})…`);
		await node.fanout().catch((error: unknown) => log(`fanout returned: ${(error as Error).message}`));
		await new Promise((r) => setTimeout(r, 3000));
		if (node.status === HydraHeadStatus.Final) break;
		if (!(await waitFor(node, HydraHeadStatus.FanoutPossible, 60_000)) && node.status !== HydraHeadStatus.Final) {
			log(`status is ${node.status}; stopping`);
			break;
		}
	}

	const references = node.getVerifiedFanoutReferences?.(Number(process.env.SNAPSHOT_NUMBER ?? '0')) ?? null;
	const result = {
		finalStatus: node.status,
		fanoutCommands: steps,
		utxosBefore: before.length,
		references,
	};
	writeFileSync(OUT, JSON.stringify(result, null, 2));
	log(`final status ${node.status} after ${steps} fanout command(s); wrote ${OUT}`);
}

main().then(
	() => process.exit(0),
	(error: unknown) => {
		console.error(error);
		process.exit(1);
	},
);
