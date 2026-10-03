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
/**
 * Where this node keeps its state. Both are overridable because the defaults
 * are the PREPROD layout, and a devnet node keeps neither in that tree — before
 * this was configurable the script could not be pointed at a devnet head at all.
 */
const NODE_LOG = process.env.HYDRA_NODE_LOG ?? join(process.cwd(), 'hydra-l2-flow', '.native-state', 'node1.log');
const PERSISTENCE_DB =
	process.env.HYDRA_PERSISTENCE_DB ??
	join(process.cwd(), 'hydra-l2-flow', 'preprod', 'persistence', 'purchasing', 'hydra.db');

function log(m: string) {
	console.log(`[sync-head] ${m}`);
}

type InitAnchor = { initTxHash: string; blockHash: string };

/**
 * InitTx + anchor block, read from the node's JSON log.
 *
 * This is the primary source since hydra-node 2.4. The event store used to be
 * queryable as JSON, but 2.4 migrated `events.event_data` to a CBOR BLOB whose
 * records are encoded positionally under Haskell constructor names — verified
 * against a real 2.4.1 store: 1,216 events, and a search for the literal text
 * `spendableUTxO` matches zero of them. The old query could only ever return
 * null there, which surfaced as "could not read the InitTx".
 *
 * The log's `Observation` frame carries everything needed and is still JSON:
 * `observedTx.tag == 'OnInitTx'`, `observedTx.headId`, the anchor block in
 * `newChainState.recordedAt.blockHash`, and `<initTxHash>#<ix>` as the first
 * key of `newChainState.spendableUTxO`.
 *
 * Matched on `headId` rather than taking the last OnInitTx, because a state dir
 * that has hosted several heads has an observation for each and the wrong one
 * silently pins the row to a dead head.
 *
 * The caveat that originally sent this to the event store still applies: the
 * harness truncates node1.log on every node start, so a node restarted since
 * its InitTx has no such line. That is why the event-store reader is kept below
 * as a fallback for pre-2.4 (JSON) stores.
 */
function findInitTxInLog(headId: string): InitAnchor | null {
	if (!existsSync(NODE_LOG)) return null;
	let found: InitAnchor | null = null;
	for (const line of readFileSync(NODE_LOG, 'utf-8').split('\n')) {
		if (!line.includes('"OnInitTx"') || !line.includes(headId)) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		const observation = locateObservation(parsed, headId);
		if (observation) found = observation;
	}
	return found;
}

/** Depth-first search for the Observation frame announcing `headId`'s InitTx. */
function locateObservation(node: unknown, headId: string): InitAnchor | null {
	if (Array.isArray(node)) {
		for (const entry of node) {
			const hit = locateObservation(entry, headId);
			if (hit) return hit;
		}
		return null;
	}
	if (typeof node !== 'object' || node === null) return null;
	const record = node as Record<string, unknown>;
	const observedTx = record.observedTx as Record<string, unknown> | undefined;
	if (observedTx?.tag === 'OnInitTx' && observedTx.headId === headId) {
		const chain = record.newChainState as ChainState | undefined;
		const reference = chain ? Object.keys(chain.spendableUTxO ?? {})[0] : undefined;
		const blockHash = chain?.recordedAt?.blockHash;
		if (reference && blockHash) return { initTxHash: reference.split('#')[0], blockHash };
	}
	for (const value of Object.values(record)) {
		const hit = locateObservation(value, headId);
		if (hit) return hit;
	}
	return null;
}

/**
 * The pre-2.4 path: a JSON event store. Returns null on a 2.4+ CBOR store,
 * which is correct — the caller falls back to the log and reports both.
 */
function findInitTx(): InitAnchor | null {
	const db = PERSISTENCE_DB;
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

	// Log first: on 2.4+ the event store is CBOR and the reader below cannot
	// answer at all. Both are tried so a node restarted since its InitTx (which
	// truncates the log) still works off a pre-2.4 JSON store.
	const init = findInitTxInLog(liveHeadId) ?? findInitTx();
	if (!init) {
		throw new Error(
			`could not read the InitTx for head ${liveHeadId}. Looked in the node log (${NODE_LOG}) and the ` +
				`event store (${PERSISTENCE_DB}). On hydra-node 2.4+ the event store is CBOR and is never readable ` +
				`here, so the log is the only source — if the node was restarted since its InitTx the harness has ` +
				`truncated that line away. Override with HYDRA_NODE_LOG=/path/to/nodeN.log.`,
		);
	}
	log(`initTx ${init.initTxHash} in block ${init.blockHash}`);

	// Chain-replay anchor = the block BEFORE the one carrying the InitTx.
	//
	// Blockfrost-only, so it is skipped when there is no project file — a devnet
	// chain is not on Blockfrost at all. The anchor is an optimisation for replay
	// (`--start-chain-from`); `initTxHash` is the field that actually gates
	// `loadValidatedHeadConfiguration`, so a head is usable without it.
	let anchorSlot: bigint | null = null;
	let anchorHash: string | null = null;
	if (existsSync(BLOCKFROST_FILE)) {
		const key = readFileSync(BLOCKFROST_FILE, 'utf-8').trim();
		const block = (await (
			await fetch(`https://cardano-preprod.blockfrost.io/api/v0/blocks/${init.blockHash}`, {
				headers: { project_id: key },
			})
		).json()) as { previous_block?: string };
		const previousBlock = block.previous_block;
		if (previousBlock) {
			const prev = (await (
				await fetch(`https://cardano-preprod.blockfrost.io/api/v0/blocks/${previousBlock}`, {
					headers: { project_id: key },
				})
			).json()) as { slot?: number };
			if (prev.slot != null) {
				anchorSlot = BigInt(prev.slot);
				anchorHash = previousBlock;
			}
		}
		if (anchorHash === null) log('WARNING could not resolve the replay anchor — pinning the head without one');
	} else {
		log(`no Blockfrost project file at ${BLOCKFROST_FILE} — pinning the head without a replay anchor`);
	}

	await prisma.hydraHead.update({
		where: { id: row.id },
		data: {
			headIdentifier: liveHeadId,
			initTxHash: init.initTxHash,
			...(anchorSlot !== null && anchorHash !== null
				? { initChainSlot: anchorSlot, initChainHash: anchorHash }
				: {}),
			status: HydraHeadStatus.Open,
			openedAt: new Date(),
			closeTxHash: null,
			fanoutTxHash: null,
		},
	});
	log(
		`DB row ${row.id} now pinned to the live head` +
			(anchorHash !== null ? ` (anchor ${anchorSlot}.${anchorHash})` : ' (no replay anchor)'),
	);
	await prisma.$disconnect();
	process.exit(0);
}

main().catch((e) => {
	console.error('[sync-head] FATAL', e instanceof Error ? e.message : e);
	process.exit(1);
});
