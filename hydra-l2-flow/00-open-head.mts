/**
 * Open a fresh Hydra head: Init via WS (node 1) + commit alice-funds' L1 UTxO
 * out-of-band (sign with alice-funds.sk + alice.sk fuel, submit via the node's
 * /cardano-transaction), wait for HeadIsOpen, print the head identifier.
 *
 * Run: pnpm exec tsx hydra-l2-flow/00-open-head.mts
 */
import { execSync } from 'node:child_process';
import { HydraNode } from '@/lib/hydra/hydra/node';
import { HydraHeadStatus } from '@/generated/prisma/client';

function log(m: string) {
	console.log(`[open] ${new Date().toISOString().slice(11, 19)} ${m}`);
}

function cli(cmd: string): string {
	return execSync(`docker exec demo-cardano-node-1 bash -c ${JSON.stringify(`export CARDANO_NODE_SOCKET_PATH=/devnet/node.socket; ${cmd}`)}`, {
		encoding: 'utf-8',
	});
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

	// alice-funds L1 address + its UTxO
	const aliceFundsAddr = cli('cardano-cli conway address build --payment-verification-key-file /devnet/credentials/alice-funds.vk --testnet-magic 42').trim();
	const utxoJson = cli(`cardano-cli conway query utxo --address ${aliceFundsAddr} --testnet-magic 42 --out-file /dev/stdout`);
	const utxos = JSON.parse(utxoJson) as Record<string, { value: { lovelace: number }; address: string }>;
	const utxoKey = Object.keys(utxos)[0];
	const [txHash, ixStr] = utxoKey.split('#');
	const lovelace = utxos[utxoKey].value.lovelace;
	log(`committing alice-funds ${utxoKey} (${lovelace})`);

	const commitBody = {
		[utxoKey]: {
			address: aliceFundsAddr,
			datum: null, datumhash: null, inlineDatum: null, inlineDatumRaw: null, referenceScript: null,
			value: { lovelace },
		},
	};
	const draft = (await httpPost('http://127.0.0.1:4001/commit', commitBody)) as { cborHex?: string };
	if (!draft.cborHex) throw new Error(`commit draft failed: ${JSON.stringify(draft).slice(0, 300)}`);

	// sign with alice-funds.sk + alice.sk (fuel) and submit via /cardano-transaction
	const envelope = JSON.stringify({ type: 'Tx ConwayEra', description: '', cborHex: draft.cborHex });
	const signedJson = execSync(
		`docker exec -i demo-cardano-node-1 bash -c ${JSON.stringify(
			'cat > /tmp/commit.tx && CARDANO_NODE_SOCKET_PATH=/devnet/node.socket cardano-cli conway transaction sign --tx-file /tmp/commit.tx --signing-key-file /devnet/credentials/alice-funds.sk --signing-key-file /devnet/credentials/alice.sk --testnet-magic 42 --out-file /tmp/commit.signed && cat /tmp/commit.signed',
		)}`,
		{ input: envelope, encoding: 'utf-8' },
	);
	const signed = JSON.parse(signedJson) as { cborHex: string };
	const submit = await httpPost('http://127.0.0.1:4001/cardano-transaction', { type: 'Tx ConwayEra', description: '', cborHex: signed.cborHex });
	log(`commit submit: ${JSON.stringify(submit).slice(0, 80)}`);

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
