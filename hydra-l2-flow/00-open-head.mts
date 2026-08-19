/**
 * Open a fresh Hydra head: Init via WS (node 1) + commit the funds party's L1 UTxO
 * out-of-band (sign with funds key, submit via the node's /cardano-transaction),
 * wait for HeadIsOpen, print the head identifier.
 *
 * Run: pnpm exec tsx hydra-l2-flow/00-open-head.mts
 * Preprod: HYDRA_FLOW_NETWORK=preprod pnpm exec tsx hydra-l2-flow/00-open-head.mts
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HydraNode } from '@/lib/hydra/hydra/node';
import { HydraHeadStatus } from '@/generated/prisma/client';

const NETWORK = process.env.HYDRA_FLOW_NETWORK ?? 'devnet';
const PREPROD_DIR = join(process.cwd(), 'hydra-l2-flow', 'preprod');

function log(m: string) {
	console.log(`[open] ${new Date().toISOString().slice(11, 19)} ${m}`);
}

function cli(cmd: string): string {
	if (NETWORK === 'preprod') {
		// --entrypoint cardano-cli: strip the leading 'cardano-cli ' to avoid doubling it
		const args = cmd.startsWith('cardano-cli ') ? cmd.slice('cardano-cli '.length) : cmd;
		return execSync(
			`docker run --rm -v ${JSON.stringify(PREPROD_DIR)}:/keys --entrypoint cardano-cli ghcr.io/intersectmbo/cardano-node:10.6.2 ${args}`,
			{ encoding: 'utf-8' },
		);
	}
	return execSync(`docker exec demo-cardano-node-1 bash -c ${JSON.stringify(`export CARDANO_NODE_SOCKET_PATH=/devnet/node.socket; ${cmd}`)}`, {
		encoding: 'utf-8',
	});
}

async function fetchUtxoJson(address: string): Promise<Record<string, { value: { lovelace: number }; address: string }>> {
	if (NETWORK === 'preprod') {
		const projectId = readFileSync(join(PREPROD_DIR, 'blockfrost.txt'), 'utf-8').trim();
		const res = await fetch(
			`https://cardano-preprod.blockfrost.io/api/v0/addresses/${address}/utxos`,
			{ headers: { project_id: projectId } },
		);
		const utxos = (await res.json()) as Array<{
			tx_hash: string;
			output_index: number;
			amount: Array<{ unit: string; quantity: string }>;
		}>;
		const out: Record<string, { value: { lovelace: number }; address: string }> = {};
		for (const u of utxos) {
			const lovelace = Number(u.amount.find((a) => a.unit === 'lovelace')?.quantity ?? '0');
			out[`${u.tx_hash}#${u.output_index}`] = { value: { lovelace }, address };
		}
		return out;
	}
	const json = cli(`cardano-cli conway query utxo --address ${address} --testnet-magic 42 --out-file /dev/stdout`);
	return JSON.parse(json) as Record<string, { value: { lovelace: number }; address: string }>;
}

const BLOCKFROST_BASE = 'https://cardano-preprod.blockfrost.io/api/v0';

function bfKey(): string {
	return readFileSync(join(PREPROD_DIR, 'blockfrost.txt'), 'utf-8').trim();
}

async function bfTxKnown(txId: string): Promise<boolean> {
	const res = await fetch(`${BLOCKFROST_BASE}/txs/${txId}`, { headers: { project_id: bfKey() } });
	return res.status === 200;
}

async function bfSubmit(cborHex: string): Promise<{ ok: boolean; body: string }> {
	const res = await fetch(`${BLOCKFROST_BASE}/tx/submit`, {
		method: 'POST',
		headers: { project_id: bfKey(), 'Content-Type': 'application/cbor' },
		body: Buffer.from(cborHex, 'hex'),
	});
	return { ok: res.ok, body: await res.text() };
}

async function httpPost(url: string, body: unknown): Promise<unknown> {
	const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
	const t = await res.text();
	try { return JSON.parse(t); } catch { return t; }
}

async function main() {
	const node = new HydraNode({ httpUrl: 'http://127.0.0.1:4001' });
	node.connect();
	await new Promise((r) => setTimeout(r, 1500));

	log(`init… (status ${node.status})`);
	await node.init();
	log(`initialised (status ${node.status})`);

	// Derive the funds address and query its UTxOs (network-aware).
	const fundsVk = NETWORK === 'preprod' ? '/keys/purchasing-cardano.vk' : '/devnet/credentials/alice-funds.vk';
	const magic = NETWORK === 'preprod' ? 1 : 42;
	const fundsAddr = cli(`cardano-cli conway address build --payment-verification-key-file ${fundsVk} --testnet-magic ${magic}`).trim();
	const fundsSk = NETWORK === 'preprod' ? '/keys/purchasing-cardano.sk' : '/devnet/credentials/alice-funds.sk';

	// Minimum lovelace the committed UTxO must carry: enough for buyer (40 ADA) +
	// seller (20 ADA) in-head funding plus margin. Kept well below any reasonable
	// fuel-UTxO size (see selection note below).
	const MIN_COMMIT_LOVELACE = 100_000_000;

	// The node's own cardano wallet (the SAME address as the funds address, since
	// hydra-native.sh passes purchasing-cardano.sk as --cardano-signing-key) is also
	// used by the node to pay the deposit tx's fee. Its fee-UTxO selector
	// (findLargestUTxO in Wallet.hs) has no awareness of what the partial tx already
	// spends — it just grabs the wallet's LARGEST UTxO. If we commit the largest
	// UTxO, findLargestUTxO picks that SAME UTxO for the fee, colliding with the
	// deposit's own spend input and leaving nothing to pay the fee with →
	// NotEnoughFuel (Hydra issue #570 is the same class of bug; #1442 documents
	// operators routing around it entirely with a separate wallet). So we must
	// commit the SMALLEST UTxO that still clears MIN_COMMIT_LOVELACE, leaving the
	// larger UTxO(s) as fuel headroom that findLargestUTxO will pick instead.
	//
	// Retry the whole query→commit→sign→submit a few times in case Blockfrost's
	// query layer briefly lags the node's own view of the address.
	let submitted = false;
	for (let attempt = 1; attempt <= 40 && !submitted; attempt++) {
		const utxos = await fetchUtxoJson(fundsAddr);
		const candidates = Object.keys(utxos)
			.filter((k) => utxos[k].value.lovelace >= MIN_COMMIT_LOVELACE)
			.sort((a, b) => utxos[a].value.lovelace - utxos[b].value.lovelace);
		const utxoKey = candidates[0];
		if (!utxoKey) throw new Error(`no UTxO ≥ ${MIN_COMMIT_LOVELACE} lovelace found at ${fundsAddr} — fund it via faucet first`);
		const lovelace = utxos[utxoKey].value.lovelace;
		const hasLargerFuelUtxo = Object.keys(utxos).some((k) => k !== utxoKey && utxos[k].value.lovelace > lovelace);
		if (!hasLargerFuelUtxo) {
			throw new Error(
				`no UTxO at ${fundsAddr} is larger than the ${lovelace}-lovelace commit candidate — need a bigger fuel UTxO left over for the node's own wallet (see NotEnoughFuel note above)`,
			);
		}

		const commitBody = {
			[utxoKey]: {
				address: fundsAddr,
				datum: null, datumhash: null, inlineDatum: null, inlineDatumRaw: null, referenceScript: null,
				value: { lovelace },
			},
		};
		const draft = (await httpPost('http://127.0.0.1:4001/commit', commitBody)) as { cborHex?: string };
		if (!draft.cborHex) {
			log(`commit attempt ${attempt}: node not ready (${JSON.stringify(draft).slice(0, 140)}); retrying in 10s…`);
			await new Promise((r) => setTimeout(r, 10000));
			continue;
		}
		log(`committing ${fundsAddr} ${utxoKey} (${lovelace})`);

		// Sign and submit via /cardano-transaction (network-aware).
		const envelope = JSON.stringify({ type: 'Tx ConwayEra', description: '', cborHex: draft.cborHex });
		const signedJson =
			NETWORK === 'preprod'
				? execSync(
						`docker run --rm -i -v ${JSON.stringify(PREPROD_DIR)}:/keys --entrypoint sh ghcr.io/intersectmbo/cardano-node:10.6.2 -c ` +
							JSON.stringify(
								`cat > /tmp/commit.tx && cardano-cli conway transaction sign --tx-file /tmp/commit.tx --signing-key-file ${fundsSk} --testnet-magic ${magic} --out-file /tmp/commit.signed && cat /tmp/commit.signed`,
							),
						{ input: envelope, encoding: 'utf-8' },
					)
				: execSync(
						`docker exec -i demo-cardano-node-1 bash -c ${JSON.stringify(
							'cat > /tmp/commit.tx && CARDANO_NODE_SOCKET_PATH=/devnet/node.socket cardano-cli conway transaction sign --tx-file /tmp/commit.tx --signing-key-file /devnet/credentials/alice-funds.sk --signing-key-file /devnet/credentials/alice.sk --testnet-magic 42 --out-file /tmp/commit.signed && cat /tmp/commit.signed',
						)}`,
						{ input: envelope, encoding: 'utf-8' },
					);
		const signed = JSON.parse(signedJson) as { cborHex: string };
		const submit = await httpPost('http://127.0.0.1:4001/cardano-transaction', { type: 'Tx ConwayEra', description: '', cborHex: signed.cborHex });
		log(`commit submit: ${JSON.stringify(submit).slice(0, 80)}`);
		if (NETWORK !== 'preprod') {
			submitted = true;
			continue;
		}
		// Blockfrost's submit endpoint can accept a tx ("PostedTx") and then
		// silently drop it — seen 2026-07-02: deposit 768ba2b4… accepted, never on
		// chain, not in mempool, input still unspent. The deposit tx also carries a
		// ~200s upper validity bound, so a drop is unrecoverable once that passes.
		// Confirm the tx actually lands; resubmit the SAME signed tx (same txid) if
		// it goes missing; if it never appears (validity expired), loop back and
		// re-draft a fresh deposit.
		const txId = execSync(
			`docker run --rm -i --entrypoint sh ghcr.io/intersectmbo/cardano-node:10.6.2 -c ` +
				JSON.stringify('cat > /tmp/commit.signed && cardano-cli conway transaction txid --tx-file /tmp/commit.signed'),
			{ input: signedJson, encoding: 'utf-8' },
		).trim();
		log(`deposit tx ${txId} — waiting for it to appear on L1…`);
		let known = false;
		for (let i = 0; i < 12 && !known; i++) {
			await new Promise((r) => setTimeout(r, 10000));
			known = await bfTxKnown(txId);
		}
		if (!known) {
			const re = await bfSubmit(signed.cborHex);
			log(`deposit tx not visible after 120s — resubmitted via Blockfrost: ${re.ok ? 'accepted' : re.body.slice(0, 140)}`);
			for (let i = 0; i < 9 && !known; i++) {
				await new Promise((r) => setTimeout(r, 10000));
				known = await bfTxKnown(txId);
			}
		}
		if (known) {
			log(`deposit tx ${txId} CONFIRMED on L1`);
			submitted = true;
		} else {
			log('deposit tx never appeared (validity likely expired) — re-drafting a fresh deposit…');
		}
	}
	if (!submitted) throw new Error('commit failed after retries — node never synced enough to draft the deposit');

	log('waiting for HeadIsOpen…');
	const start = Date.now();
	while (node.status !== HydraHeadStatus.Open) {
		if (Date.now() - start > 120000) throw new Error(`timeout; status ${node.status}`);
		await new Promise((r) => setTimeout(r, 1000));
	}
	const snap = await node.snapshotUTxO();
	log(`=== HEAD OPEN === snapshot UTxOs: ${snap.length}`);
	for (const u of snap) log(`  ${u.input.txHash.slice(0, 12)}…#${u.input.outputIndex} ${u.output.amount.find((a) => a.unit === 'lovelace')?.quantity}`);
	process.exit(0);
}
main().catch((e) => { console.error('[open] FATAL', e); process.exit(1); });
