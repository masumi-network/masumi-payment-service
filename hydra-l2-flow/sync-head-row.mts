/**
 * Point the DB's HydraHead row at the head that is ACTUALLY live on the node.
 *
 * Why this exists: `seed-head-row.mts` reuses an existing row, so after opening
 * a NEW head the row still carries the PREVIOUS head's `headIdentifier`. The
 * connection manager pins that value and then rejects every frame from the live
 * head with:
 *     HydraProtocolError: Hydra frame head id did not match the pinned head
 * which makes any service-driven bench (lock/submit/collect) fail immediately.
 *
 * It also refreshes the InitTx anchor, because `loadValidatedHeadConfiguration`
 * refuses to connect to a head whose `initTxHash` is null.
 *
 * The InitTx is recovered from the node's OWN chain observation rather than
 * from Blockfrost: the OnInitTx frame's `newChainState.spendableUTxO` key is
 * `<initTxHash>#<ix>`, and `recordedAt` gives the block that carried it.
 *
 * Run: DATABASE_URL=... pnpm exec tsx hydra-l2-flow/sync-head-row.mts [nodeHttpUrl]
 */
import 'dotenv/config';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { prisma } from '@masumi/payment-core/db';
import { HydraHeadStatus } from '@/generated/prisma/client';

const NODE = process.argv[2] ?? 'http://127.0.0.1:4001';
const BLOCKFROST_FILE = join(process.cwd(), 'hydra-l2-flow', 'preprod', 'blockfrost.txt');

function log(m: string) {
	console.log(`[sync-head] ${m}`);
}

/**
 * InitTx + anchor block, read from the node's OWN event store.
 *
 * Deliberately NOT parsed from node1.log: the harness truncates that log on
 * every node start, so after any restart the OnInitTx line is gone. The event
 * store persists across restarts, and its first `HeadOpened` event carries the
 * chain state whose `spendableUTxO` key is `<initTxHash>#<ix>`.
 */
function findInitTx(): { initTxHash: string; blockHash: string } | null {
	const db = join(process.cwd(), 'hydra-l2-flow', 'preprod', 'persistence', 'purchasing', 'hydra.db');
	if (!existsSync(db)) return null;
	// Copy first — the live DB has a hot WAL and must never be written to.
	const dir = mkdtempSync(join(tmpdir(), 'sync-head-'));
	const copy = join(dir, 'hydra.db');
	try {
		copyFileSync(db, copy);
		for (const suffix of ['-wal', '-shm']) {
			if (existsSync(db + suffix)) copyFileSync(db + suffix, copy + suffix);
		}
		const out = execFileSync(
			'sqlite3',
			[copy, "SELECT event_data FROM events WHERE event_data LIKE '%spendableUTxO%' ORDER BY event_id LIMIT 1;"],
			{ encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 },
		).trim();
		if (!out) return null;
		const chain = locateChainState(JSON.parse(out) as unknown);
		if (!chain) return null;
		const ref = Object.keys(chain.spendableUTxO)[0];
		if (!ref || !chain.recordedAt?.blockHash) return null;
		return { initTxHash: ref.split('#')[0], blockHash: chain.recordedAt.blockHash };
	} catch {
		return null;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

type ChainState = { spendableUTxO: Record<string, unknown>; recordedAt?: { blockHash?: string } };

function locateChainState(node: unknown): ChainState | null {
	if (Array.isArray(node)) {
		for (const item of node) {
			const hit = locateChainState(item);
			if (hit) return hit;
		}
		return null;
	}
	if (node && typeof node === 'object') {
		const record = node as Record<string, unknown>;
		if (record.spendableUTxO && record.recordedAt) return record as unknown as ChainState;
		for (const value of Object.values(record)) {
			const hit = locateChainState(value);
			if (hit) return hit;
		}
	}
	return null;
}

async function main() {
	const headState = (await (await fetch(`${NODE}/head`)).json()) as Record<string, unknown>;
	const liveHeadId = JSON.stringify(headState).match(/"headId":"([a-f0-9]{56})"/)?.[1];
	if (!liveHeadId) throw new Error(`could not read a headId from ${NODE}/head — is the head open?`);
	log(`live head ${liveHeadId}`);

	const row = await prisma.hydraHead.findFirst({ orderBy: { createdAt: 'desc' } });
	if (!row) throw new Error('no HydraHead row — run seed-head-row.mts first');
	if (row.headIdentifier === liveHeadId && row.initTxHash != null) {
		log('DB row already matches the live head — nothing to do');
		await prisma.$disconnect();
		process.exit(0);
	}

	const init = findInitTx();
	if (!init) {
		throw new Error(
			'could not read the InitTx from the head event store (preprod/persistence/purchasing/hydra.db)',
		);
	}
	log(`initTx ${init.initTxHash} in block ${init.blockHash}`);

	// Chain-replay anchor = the block BEFORE the one carrying the InitTx.
	const key = readFileSync(BLOCKFROST_FILE, 'utf-8').trim();
	const block = (await (
		await fetch(`https://cardano-preprod.blockfrost.io/api/v0/blocks/${init.blockHash}`, {
			headers: { project_id: key },
		})
	).json()) as { previous_block?: string };
	if (!block.previous_block) throw new Error('could not resolve the previous block for the anchor');
	const prev = (await (
		await fetch(`https://cardano-preprod.blockfrost.io/api/v0/blocks/${block.previous_block}`, {
			headers: { project_id: key },
		})
	).json()) as { slot?: number };
	if (prev.slot == null) throw new Error('could not resolve the anchor slot');

	await prisma.hydraHead.update({
		where: { id: row.id },
		data: {
			headIdentifier: liveHeadId,
			initTxHash: init.initTxHash,
			initChainSlot: BigInt(prev.slot),
			initChainHash: block.previous_block,
			status: HydraHeadStatus.Open,
			openedAt: new Date(),
			closeTxHash: null,
			fanoutTxHash: null,
		},
	});
	log(`DB row ${row.id} now pinned to the live head (anchor ${prev.slot}.${block.previous_block})`);
	await prisma.$disconnect();
	process.exit(0);
}

main().catch((e) => {
	console.error('[sync-head] FATAL', e instanceof Error ? e.message : e);
	process.exit(1);
});
