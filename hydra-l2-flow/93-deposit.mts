/**
 * Standalone deposit: commit ONE named purchasing-wallet UTxO into the open
 * head via POST /commit → sign → POST /cardano-transaction, then confirm the
 * deposit tx lands on L1 (Blockfrost), resubmitting the SAME signed tx if the
 * submit was silently dropped.
 *
 * Run: pnpm exec tsx hydra-l2-flow/93-deposit.mts <txHash#index> <lovelace>
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const [utxoKey, lovelaceStr] = process.argv.slice(2);
if (!lovelaceStr) {
	console.error('usage: 93-deposit.mts <txHash#index> <lovelace>');
	process.exit(2);
}
const PREPROD_DIR = join(process.cwd(), 'hydra-l2-flow', 'preprod');
const CARDANO_NODE_IMAGE = 'ghcr.io/intersectmbo/cardano-node:10.6.2';
const BLOCKFROST_KEY = readFileSync(join(PREPROD_DIR, 'blockfrost.txt'), 'utf-8').trim();

function log(m: string) {
	console.log(`[deposit] ${new Date().toISOString().slice(11, 19)} ${m}`);
}

function fundsAddr(): string {
	return execFileSync(
		'docker',
		['run', '--rm', '-v', `${PREPROD_DIR}:/keys`, '--entrypoint', 'cardano-cli', CARDANO_NODE_IMAGE,
			'address', 'build', '--payment-verification-key-file', '/keys/purchasing-cardano.vk', '--testnet-magic', '1'],
		{ encoding: 'utf-8' },
	).trim();
}

async function httpPost(url: string, body: unknown): Promise<unknown> {
	const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
	const t = await res.text();
	try { return JSON.parse(t); } catch { return t; }
}

async function main() {
	const addr = fundsAddr();
	const commitBody = {
		[utxoKey]: {
			address: addr, datum: null, datumhash: null, inlineDatum: null,
			inlineDatumRaw: null, referenceScript: null, value: { lovelace: Number(lovelaceStr) },
		},
	};
	const draft = (await httpPost('http://127.0.0.1:4001/commit', commitBody)) as { cborHex?: string };
	if (!draft.cborHex) throw new Error(`draft failed: ${JSON.stringify(draft).slice(0, 300)}`);
	log(`draft ok; signing…`);
	const envelope = JSON.stringify({ type: 'Tx ConwayEra', description: '', cborHex: draft.cborHex });
	const signedJson = execFileSync(
		'docker',
		['run', '--rm', '-i', '-v', `${PREPROD_DIR}:/keys`, '--entrypoint', 'sh', CARDANO_NODE_IMAGE, '-c',
			'cat > /tmp/c.tx && cardano-cli conway transaction sign --tx-file /tmp/c.tx --signing-key-file /keys/purchasing-cardano.sk --testnet-magic 1 --out-file /tmp/c.signed && cardano-cli conway transaction txid --tx-file /tmp/c.signed >&2 && cat /tmp/c.signed'],
		{ input: envelope, encoding: 'utf-8' },
	);
	const signed = JSON.parse(signedJson) as { cborHex: string };
	const submit = await httpPost('http://127.0.0.1:4001/cardano-transaction', { type: 'Tx ConwayEra', description: '', cborHex: signed.cborHex });
	log(`submit: ${JSON.stringify(submit).slice(0, 100)}`);
	const txId = execFileSync(
		'docker',
		['run', '--rm', '-i', '--entrypoint', 'sh', CARDANO_NODE_IMAGE, '-c',
			'cat > /tmp/c.signed && cardano-cli conway transaction txid --tx-file /tmp/c.signed'],
		{ input: signedJson, encoding: 'utf-8' },
	).trim();
	log(`deposit txid ${txId} — waiting for the NODE to observe it (GET /commits)…`);
	for (let i = 0; i < 100; i++) {
		await new Promise((r) => setTimeout(r, 15000));
		const cm = (await (await fetch('http://127.0.0.1:4001/commits')).json()) as string[];
		if (cm.includes(txId)) { log('DEPOSIT OBSERVED BY NODE'); return; }
		if (i % 8 === 7) {
			const rs = await fetch('https://cardano-preprod.blockfrost.io/api/v0/tx/submit', {
				method: 'POST', headers: { project_id: BLOCKFROST_KEY, 'Content-Type': 'application/cbor' },
				body: Buffer.from(signed.cborHex, 'hex'),
			});
			const body = await rs.text();
			// A BadInputsUTxO rejection of our OWN input means the tx already landed;
			// keep waiting for the node's follower to reach it.
			log(`resubmit status ${rs.status}: ${body.slice(0, 120)}`);
		}
	}
	throw new Error('deposit never observed by node');
}

main().catch((e) => { console.error('[deposit] FATAL', e); process.exit(1); });
