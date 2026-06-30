/**
 * Phase 3 — give the masumi buyer wallet spendable IN-HEAD funds via a plain L2
 * transfer from the existing in-head balance (alice-funds → masumi address).
 *
 * This sidesteps the L1 commit/deposit path (whose UTxO *fetch* is Blockfrost-
 * bound and so can't see the devnet) and gets us straight to what the escrow
 * services need: the masumi wallet owning in-head UTxOs.
 *
 * Run: pnpm exec tsx hydra-l2-flow/02-fund-in-head.mts <masumi_addr> <amount_lovelace>
 */
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshTxBuilder } from '@meshsdk/core';
import { HydraNode } from '@/lib/hydra/hydra/node';
import { HydraProvider } from '@/lib/hydra/hydra/provider';

const MASUMI_ADDR = process.argv[2];
const AMOUNT = process.argv[3] ?? '60000000';
const ALICE_FUNDS_SK = '/devnet/credentials/alice-funds.sk';

function log(m: string) {
	console.log(`[fund-in-head] ${new Date().toISOString().slice(11, 19)} ${m}`);
}

function signWithCardanoCli(cborHex: string, credKeyPath: string): string {
	const tmpIn = join(tmpdir(), `l2-draft-${Date.now()}.tx`);
	const tmpOut = join(tmpdir(), `l2-signed-${Date.now()}.tx`);
	writeFileSync(tmpIn, JSON.stringify({ type: 'Tx ConwayEra', description: '', cborHex }));
	try {
		const id = Date.now();
		execSync(`docker cp "${tmpIn}" demo-cardano-node-1:/tmp/d-${id}.tx`, { stdio: 'pipe' });
		execSync(
			`docker exec demo-cardano-node-1 cardano-cli conway transaction sign ` +
				`--tx-file /tmp/d-${id}.tx --signing-key-file "${credKeyPath}" --testnet-magic 42 --out-file /tmp/s-${id}.tx`,
			{ stdio: 'pipe' },
		);
		execSync(`docker cp demo-cardano-node-1:/tmp/s-${id}.tx "${tmpOut}"`, { stdio: 'pipe' });
		return (JSON.parse(readFileSync(tmpOut, 'utf-8')) as { cborHex: string }).cborHex;
	} finally {
		try {
			unlinkSync(tmpIn);
		} catch {
			/* ignore */
		}
		try {
			unlinkSync(tmpOut);
		} catch {
			/* ignore */
		}
	}
}

async function main() {
	if (!MASUMI_ADDR) throw new Error('usage: 02-fund-in-head.mts <masumi_addr> [amount]');
	const node = new HydraNode({ httpUrl: 'http://127.0.0.1:4001' });
	node.connect();
	await new Promise((r) => setTimeout(r, 1500));

	const provider = new HydraProvider({ node });
	await new Promise((r) => setTimeout(r, 600));

	const utxos = await node.snapshotUTxO();
	log(`in-head UTxOs: ${utxos.length}`);
	for (const u of utxos) {
		const ada = u.output.amount.find((a) => a.unit === 'lovelace')?.quantity;
		log(`  ${u.input.txHash.slice(0, 12)}…#${u.input.outputIndex} ${u.output.address.slice(0, 22)}… ${ada}`);
	}
	// Pick the largest pure-ADA UTxO owned by alice-funds as the funding source.
	// Exclude datum-bearing (script) outputs — they can't be key-signed.
	const ALICE_FUNDS_ADDR = 'addr_test1vp5cxztpc6hep9ds7fjgmle3l225tk8ske3rmwr9adu0m6qchmx5z';
	const source = [...utxos]
		.filter(
			(u) =>
				!u.output.plutusData &&
				u.output.address === ALICE_FUNDS_ADDR &&
				u.output.amount.length === 1 &&
				u.output.amount[0].unit === 'lovelace',
		)
		.sort((a, b) => Number(BigInt(b.output.amount[0].quantity) - BigInt(a.output.amount[0].quantity)))[0];
	if (!source) throw new Error('no pure-ADA in-head UTxO to fund from');
	log(
		`funding source: ${source.input.txHash.slice(0, 12)}…#${source.input.outputIndex} (${source.output.amount[0].quantity}) owner=${source.output.address.slice(0, 22)}…`,
	);

	// isHydra zeroes the fee params; setFee('0') forces a zero fee so the in-head
	// transfer conserves value exactly. A non-zero fee would shrink the L2 UTxO
	// total while the head output stays constant, accumulating into the head's
	// headAdaOverhead until Close fails (H65, ChangedHeadAdaOverhead).
	const tx = new MeshTxBuilder({ fetcher: provider, submitter: provider, isHydra: true });
	await tx
		.txIn(source.input.txHash, source.input.outputIndex, source.output.amount, source.output.address)
		.txOut(MASUMI_ADDR, [{ unit: 'lovelace', quantity: AMOUNT }])
		.setFee('0')
		.changeAddress(source.output.address)
		.complete();

	log('signing with alice-funds.sk (in-head UTxO owner)…');
	const signed = signWithCardanoCli(tx.txHex, ALICE_FUNDS_SK);
	const txHash = await provider.submitTx(signed);
	log(`submitted L2 funding tx: ${txHash}`);

	const confirmed = await Promise.race([
		node.awaitTx(txHash, 500).then(() => true),
		new Promise<boolean>((r) => setTimeout(() => r(false), 15000)),
	]);
	log(`confirmed in snapshot: ${confirmed}`);

	const after = await node.snapshotUTxO();
	const masumiUtxos = after.filter((u) => u.output.address === MASUMI_ADDR);
	log(`masumi now owns ${masumiUtxos.length} in-head UTxO(s):`);
	for (const u of masumiUtxos) {
		const ada = u.output.amount.find((a) => a.unit === 'lovelace')?.quantity;
		log(`  ${u.input.txHash.slice(0, 16)}…#${u.input.outputIndex} ${ada} lovelace`);
	}
	process.exit(0);
}

main().catch((e) => {
	console.error('[fund-in-head] FATAL', e);
	process.exit(1);
});
