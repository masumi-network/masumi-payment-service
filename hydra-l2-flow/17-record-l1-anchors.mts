/**
 * Record a head's L1 anchor transactions, with Cardanoscan links.
 *
 * Why not reuse what settle already does: `13-settle.mts` recovers close/fanout
 * hashes by scraping node1.log for `"transactionId"` (settle-shared.mts:107).
 * That is unreliable — on 2026-08-31 it recorded a closeTx that returns 404 from
 * Blockfrost. This asks the chain instead.
 *
 * Selection is by HEAD TOKEN POLICY, never by address. Every Hydra head on a
 * network shares one head script address, so an address query returns other
 * people's heads too; on 2026-08-31 that made this script label our Close and
 * Fanout as "increment". The head id IS the minting policy of the head's own
 * tokens, so "carries an asset whose policy == headId" identifies exactly the
 * transactions belonging to this head.
 *
 * The L2 transactions are deliberately absent: in-head payments never touch L1,
 * which is the point of the head. Their proof is the multi-signed
 * ConfirmedSnapshot, whose balances equal the fanout outputs recorded here.
 *
 * Run: pnpm exec tsx hydra-l2-flow/17-record-l1-anchors.mts --out <file.json> [--head-id <hex>]
 * Head id resolution: --head-id, else $HEAD_IDENTIFIER, else the live node's /head.
 */
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MeshWallet } from '@meshsdk/core';

const DIR = join(process.cwd(), 'hydra-l2-flow', 'preprod');
const BF = readFileSync(join(DIR, 'blockfrost.txt'), 'utf-8').trim();
const API = 'https://cardano-preprod.blockfrost.io/api/v0';
const SCAN = 'https://preprod.cardanoscan.io/transaction';
const NODE1 = process.env.HYDRA_NODE1_HTTP ?? 'http://127.0.0.1:4001';
const SINCE_MS = Number(process.env.SINCE_HOURS ?? 8) * 3600 * 1000;
const SETTLEMENT_STATE =
	process.env.SETTLEMENT_STATE ?? join(process.cwd(), 'hydra-l2-flow', '.native-state', 'settlement.json');

const arg = (n: string) => {
	const i = process.argv.indexOf(n);
	return i > -1 ? process.argv[i + 1] : undefined;
};
const OUT = arg('--out') ?? join(process.cwd(), 'hydra-l2-flow', 'evidence', 'l1-anchors.json');
const log = (m: string) => console.log(`[anchors] ${m}`);

async function bf<T>(path: string): Promise<T | null> {
	const res = await fetch(`${API}${path}`, { headers: { project_id: BF } });
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
	return (await res.json()) as T;
}

type Amount = { unit: string; quantity: string };
type TxMeta = {
	hash: string;
	block_height: number;
	block_time: number;
	slot: number;
	valid_contract: boolean;
	asset_mint_or_burn_count: number;
};
type Utxos = {
	inputs: Array<{ address: string; amount: Amount[]; tx_hash: string }>;
	outputs: Array<{ address: string; amount: Amount[] }>;
};

const isScript = (a: string) =>
	a.startsWith('addr_test1w') || a.startsWith('addr_test1z') || a.startsWith('addr1w') || a.startsWith('addr1z');
const policies = (amts: Amount[]) => amts.filter((a) => a.unit !== 'lovelace').map((a) => a.unit.slice(0, 56));

async function resolveHeadId(): Promise<string | null> {
	const explicit = arg('--head-id') ?? process.env.HEAD_IDENTIFIER;
	if (explicit && /^[0-9a-f]{56}$/.test(explicit)) return explicit;
	try {
		const res = await fetch(`${NODE1}/head`, { signal: AbortSignal.timeout(8000) });
		const m = JSON.stringify(await res.json()).match(/"headId":"([0-9a-f]{56})"/);
		if (m) return m[1];
	} catch {
		/* node may be down or Idle after fanout */
	}
	return null;
}

async function main() {
	const headId = await resolveHeadId();
	if (!headId) {
		console.error('[anchors] could not resolve the head id — pass --head-id <56 hex> (the node is Idle after fanout)');
		process.exit(2);
	}
	log(`head ${headId}`);

	const { cborHex } = JSON.parse(readFileSync(join(DIR, 'purchasing-cardano.sk'), 'utf-8')) as { cborHex: string };
	const wallet = new MeshWallet({ networkId: 0, key: { type: 'cli', payment: cborHex } });
	await (wallet as unknown as { init?: () => Promise<void> }).init?.();
	const purchasing = wallet.getAddresses().enterpriseAddressBech32!;
	const sinceSec = Math.floor((Date.now() - SINCE_MS) / 1000);

	// Every tx that ever moved one of this head's tokens. Blockfrost indexes by
	// asset, so this needs no address guesswork and cannot pick up another head.
	const assets = (await bf<Array<{ asset: string }>>(`/assets/policy/${headId}`)) ?? [];
	const hashes = new Set<string>();
	let initTx: string | null = null;
	let fanoutTx: string | null = null;

	for (const { asset } of assets) {
		// /history carries the mint and the BURN. /transactions does not list the
		// burning transaction (the asset is absent from its outputs), which is how
		// the fanout went missing on the first attempt.
		const hist = (await bf<Array<{ tx_hash: string; action: string }>>(`/assets/${asset}/history?count=100`)) ?? [];
		for (const h of hist) {
			hashes.add(h.tx_hash);
			if (h.action === 'minted') initTx ??= h.tx_hash;
			if (h.action === 'burned') fanoutTx ??= h.tx_hash;
		}
		let page = 1;
		for (;;) {
			const rows = (await bf<Array<{ tx_hash: string }>>(`/assets/${asset}/transactions?count=100&page=${page}`)) ?? [];
			rows.forEach((r) => hashes.add(r.tx_hash));
			if (rows.length < 100) break;
			page++;
		}
	}
	log(`${assets.length} head asset(s), ${hashes.size} tx(s) touching them`);

	const detail = new Map<string, { meta: TxMeta; utxos: Utxos }>();
	for (const h of hashes) {
		const meta = await bf<TxMeta>(`/txs/${h}`);
		const utxos = await bf<Utxos>(`/txs/${h}/utxos`);
		if (meta && utxos) detail.set(h, { meta, utxos });
	}

	// Close is whichever transaction produced the head output that Fanout spends.
	// Deterministic, unlike counting script inputs: Increment and Close can both
	// present a single head-script input depending on how the deposit was built.
	let closeTx: string | null = null;
	if (fanoutTx && detail.has(fanoutTx)) {
		const parent = detail
			.get(fanoutTx)!
			.utxos.inputs.find((i) => isScript(i.address) && policies(i.amount).includes(headId));
		closeTx = parent?.tx_hash ?? null;
	}

	const classify = (h: string, meta: TxMeta, u: Utxos): string => {
		if (h === initTx) return 'init';
		if (h === fanoutTx) return 'fanout';
		if (h === closeTx) return 'close';
		const inHead = new Set(u.inputs.flatMap((i) => policies(i.amount))).has(headId);
		const outHead = new Set(u.outputs.flatMap((o) => policies(o.amount))).has(headId);
		if (inHead && outHead) return 'increment';
		if (!inHead && outHead && meta.asset_mint_or_burn_count > 0) return 'init';
		if (inHead && !outHead) return 'fanout';
		return 'other';
	};

	const anchors = [...detail.entries()]
		.map(([h, { meta, utxos }]) => ({
			role: classify(h, meta, utxos),
			txHash: h,
			block: meta.block_height,
			slot: meta.slot,
			time: new Date(meta.block_time * 1000).toISOString(),
			validContract: meta.valid_contract,
			cardanoscan: `${SCAN}/${h}`,
		}))
		.sort((a, b) => a.block - b.block);

	// The wallet tx that funded Init — outside the policy set, so resolve it from
	// Init's own inputs rather than guessing from the address history.
	const init = anchors.find((a) => a.role === 'init');
	if (init) {
		for (const i of detail.get(init.txHash)!.utxos.inputs) {
			if (i.address !== purchasing || detail.has(i.tx_hash)) continue;
			const meta = await bf<TxMeta>(`/txs/${i.tx_hash}`);
			if (!meta || meta.block_time < sinceSec) continue;
			anchors.unshift({
				role: 'funding',
				txHash: meta.hash,
				block: meta.block_height,
				slot: meta.slot,
				time: new Date(meta.block_time * 1000).toISOString(),
				validContract: meta.valid_contract,
				cardanoscan: `${SCAN}/${meta.hash}`,
			});
			break;
		}
	}

	const byRole = (r: string) => anchors.find((a) => a.role === r)?.txHash ?? null;
	const settlement = existsSync(SETTLEMENT_STATE)
		? (JSON.parse(readFileSync(SETTLEMENT_STATE, 'utf-8')) as { closeTx?: string | null; fanoutTx?: string | null })
		: {};

	mkdirSync(dirname(OUT), { recursive: true });
	writeFileSync(
		OUT,
		JSON.stringify(
			{
				generated: new Date().toISOString(),
				network: 'preprod',
				headId,
				purchasingAddress: purchasing,
				closeTx: byRole('close'),
				fanoutTx: byRole('fanout'),
				note: 'Selected by head-token policy, not by address: every head on a network shares one head script address. L2 transactions are absent by design — they never touch L1. Their proof is the multi-signed ConfirmedSnapshot, whose balances equal the fanout outputs.',
				anchors,
			},
			null,
			2,
		) + '\n',
	);

	log(`${anchors.length} L1 anchors -> ${OUT}`);
	for (const a of anchors) log(`  ${a.role.padEnd(9)} ${a.txHash} block ${a.block}  ${a.time}`);

	// settlement.json's hashes come from a log scrape and have been wrong before.
	for (const [k, chain] of [
		['closeTx', byRole('close')],
		['fanoutTx', byRole('fanout')],
	] as const) {
		const claimed = settlement[k];
		if (claimed && claimed !== chain)
			console.error(`[anchors] NOTE: settlement.json ${k}=${claimed} disagrees with the chain (${chain})`);
	}
}

main().catch((e) => {
	console.error('[anchors] FATAL', e);
	process.exit(2);
});
