/**
 * Consolidate ALL in-head UTxOs owned by the two node enterprise addresses
 * (purchasing-cardano / selling-cardano) into ONE UTxO at purchasing's
 * address, so 02-fund-in-head has a big enough source. Dual-signed, fee 0.
 *
 * Run: pnpm exec tsx hydra-l2-flow/consolidate-head-funds.mts [nodeHttpUrl]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { MeshTxBuilder, MeshWallet, resolveTxHash } from '@meshsdk/core';

const NODE = process.argv[2] ?? 'http://127.0.0.1:4001';
const DIR = join(process.cwd(), 'hydra-l2-flow', 'preprod');

function loadWallet(sk: string): MeshWallet {
	const { cborHex } = JSON.parse(readFileSync(join(DIR, sk), 'utf-8')) as { cborHex: string };
	return new MeshWallet({ networkId: 0, key: { type: 'cli', payment: cborHex } });
}

async function main() {
	const purchasing = loadWallet('purchasing-cardano.sk');
	const selling = loadWallet('selling-cardano.sk');
	await (purchasing as unknown as { init?: () => Promise<void> }).init?.();
	await (selling as unknown as { init?: () => Promise<void> }).init?.();
	const pAddr = purchasing.getAddresses().enterpriseAddressBech32!;
	const sAddr = selling.getAddresses().enterpriseAddressBech32!;

	const utxos = (await (await fetch(`${NODE}/snapshot/utxo`)).json()) as Record<
		string,
		{ address: string; value: { lovelace: number } }
	>;
	const owned = Object.entries(utxos).filter(([, o]) => o.address === pAddr || o.address === sAddr);
	if (owned.length < 2) {
		console.log(`nothing to consolidate (${owned.length} node-owned UTxO)`);
		return;
	}
	const total = owned.reduce((s, [, o]) => s + BigInt(o.value.lovelace), 0n);
	console.log(`consolidating ${owned.length} UTxOs (${total} lovelace) -> ${pAddr.slice(0, 24)}…`);

	const builder = new MeshTxBuilder({ isHydra: true });
	let needsSelling = false;
	for (const [ref, out] of owned) {
		const [hash, index] = ref.split('#');
		builder.txIn(hash, Number(index), [{ unit: 'lovelace', quantity: String(out.value.lovelace) }], out.address, 0);
		if (out.address === sAddr) needsSelling = true;
	}
	await builder.txOut(pAddr, [{ unit: 'lovelace', quantity: total.toString() }]).setFee('0').changeAddress(pAddr).complete();
	let signed = await purchasing.signTx(builder.txHex, true);
	if (needsSelling) signed = await selling.signTx(signed, true);
	const txId = String(resolveTxHash(signed)).toLowerCase();

	const ws = new WebSocket(`${NODE.replace('http', 'ws')}?history=no`);
	await new Promise<void>((resolve, reject) => {
		ws.on('open', () => resolve());
		ws.on('error', reject);
	});
	ws.send(JSON.stringify({ tag: 'NewTx', transaction: { type: 'Tx ConwayEra', description: '', cborHex: signed } }));
	console.log(`submitted ${txId.slice(0, 16)}… — waiting for confirmation`);
	const deadline = Date.now() + 60_000;
	for (;;) {
		await new Promise((r) => setTimeout(r, 1000));
		const now = (await (await fetch(`${NODE}/snapshot/utxo`)).json()) as Record<string, unknown>;
		if (Object.keys(now).some((k) => k.startsWith(txId))) break;
		if (Date.now() > deadline) throw new Error('consolidation tx not confirmed in 60s');
	}
	ws.close();
	console.log(`CONSOLIDATED: ${total} lovelace in one UTxO at purchasing`);
	process.exit(0);
}

main().catch((e) => {
	console.error('FATAL', e);
	process.exit(1);
});
