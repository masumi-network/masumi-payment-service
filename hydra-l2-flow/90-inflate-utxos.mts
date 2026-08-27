/**
 * Inflate the head's UTxO count until a single fanout transaction cannot hold
 * it, so that Close → Fanout exercises hydra-node's partial fanout path.
 *
 * Why a count rather than a number of transactions: what forces a split is the
 * serialized size of the fanned-out outputs against the 16 KB transaction
 * limit, not how many transactions produced them. A plain ADA output is roughly
 * 45 bytes, so fifty of them come to about 2 KB and fan out in one step. Several
 * hundred is what actually crosses the line.
 *
 * Each round spends the largest alice-funds UTxO into many small ones, in head,
 * at zero fee — the same shape as 02-fund-in-head.mts.
 *
 * Run: pnpm exec tsx hydra-l2-flow/90-inflate-utxos.mts [targetUtxoCount] [perTx]
 */
import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshTxBuilder } from '@meshsdk/core';
import { HydraNode } from '@/lib/hydra/hydra/node';
import { HydraProvider } from '@/lib/hydra/hydra/provider';

const TARGET = Number(process.argv[2] ?? '50');
const PER_TX = Number(process.argv[3] ?? '25');
/**
 * Each output carries an inline datum about the size of a V2 escrow datum, so
 * the head fills up the way a head full of FundsLocked escrows does. That is
 * what forces the fanout to split: the limit is the serialized size of the
 * outputs against a 16 KB transaction, and a bare ADA output is only ~45 bytes.
 */
const DATUM_BYTES = 480;
/** Min-UTxO scales with output size, and a datum this big needs roughly this. */
const OUTPUT_LOVELACE = 4_000_000n;
const ALICE_FUNDS_SK = '/devnet/credentials/alice-funds.sk';
const ALICE_FUNDS_ADDR = 'addr_test1vp5cxztpc6hep9ds7fjgmle3l225tk8ske3rmwr9adu0m6qchmx5z';

function log(m: string) {
	console.log(`[inflate] ${new Date().toISOString().slice(11, 19)} ${m}`);
}

function signWithCardanoCli(cborHex: string): string {
	const tmpIn = join(tmpdir(), `inflate-draft-${Date.now()}.tx`);
	const tmpOut = join(tmpdir(), `inflate-signed-${Date.now()}.tx`);
	writeFileSync(tmpIn, JSON.stringify({ type: 'Tx ConwayEra', description: '', cborHex }));
	try {
		const id = Date.now();
		execSync(`docker cp "${tmpIn}" demo-cardano-node-1:/tmp/d-${id}.tx`, { stdio: 'pipe' });
		execSync(
			`docker exec demo-cardano-node-1 cardano-cli conway transaction sign ` +
				`--tx-file /tmp/d-${id}.tx --signing-key-file "${ALICE_FUNDS_SK}" --testnet-magic 42 --out-file /tmp/s-${id}.tx`,
			{ stdio: 'pipe' },
		);
		execSync(`docker cp demo-cardano-node-1:/tmp/s-${id}.tx "${tmpOut}"`, { stdio: 'pipe' });
		return (JSON.parse(readFileSync(tmpOut, 'utf-8')) as { cborHex: string }).cborHex;
	} finally {
		for (const path of [tmpIn, tmpOut]) {
			try {
				unlinkSync(path);
			} catch {
				/* ignore */
			}
		}
	}
}

async function main() {
	const node = new HydraNode({ httpUrl: 'http://127.0.0.1:4001' });
	node.connect();
	await new Promise((r) => setTimeout(r, 1500));
	const provider = new HydraProvider({ node });
	await new Promise((r) => setTimeout(r, 600));

	let round = 0;
	for (;;) {
		const utxos = await node.snapshotUTxO();
		log(`head holds ${utxos.length} UTxOs`);
		if (utxos.length >= TARGET) {
			log(`reached the target of ${TARGET}`);
			return;
		}
		const source = [...utxos]
			.filter(
				(u) =>
					!u.output.plutusData &&
					u.output.address === ALICE_FUNDS_ADDR &&
					u.output.amount.length === 1 &&
					u.output.amount[0].unit === 'lovelace',
			)
			.sort((a, b) => Number(BigInt(b.output.amount[0].quantity) - BigInt(a.output.amount[0].quantity)))[0];
		if (!source) throw new Error('no spendable pure-ADA alice-funds UTxO left to split');

		const available = BigInt(source.output.amount[0].quantity);
		// Leave the change output above min-UTxO so the next round has a source.
		const affordable = Number((available - OUTPUT_LOVELACE * 2n) / OUTPUT_LOVELACE);
		const count = Math.max(1, Math.min(PER_TX, affordable, TARGET - utxos.length));
		if (affordable < 1) throw new Error(`largest UTxO ${available} is too small to split further`);

		const tx = new MeshTxBuilder({ fetcher: provider, submitter: provider, isHydra: true });
		tx.txIn(source.input.txHash, source.input.outputIndex, source.output.amount, source.output.address);
		for (let index = 0; index < count; index += 1) {
			tx.txOut(ALICE_FUNDS_ADDR, [
				{ unit: 'lovelace', quantity: OUTPUT_LOVELACE.toString() },
			]).txOutInlineDatumValue(
				// A key address ignores datums when spending, so these stay ordinary
				// key-signed outputs while weighing what an escrow weighs.
				{ bytes: Buffer.alloc(DATUM_BYTES, index % 251).toString('hex') },
				'JSON',
			);
		}
		await tx.setFee('0').changeAddress(ALICE_FUNDS_ADDR).complete();

		const signed = signWithCardanoCli(tx.txHex);
		const txHash = await provider.submitTx(signed);
		round += 1;
		log(`round ${round}: split ${available} into ${count} × 2 ADA + change (${txHash.slice(0, 12)}…)`);

		// Poll the snapshot rather than awaitTx: the head confirms these in about a
		// second, and what matters for the next round is that the UTxO set grew.
		const before = utxos.length;
		const deadline = Date.now() + 60_000;
		let grew = false;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 1000));
			if ((await node.snapshotUTxO()).length > before) {
				grew = true;
				break;
			}
		}
		if (!grew) throw new Error(`round ${round} did not land in the head`);
	}
}

main().then(
	() => process.exit(0),
	(error: unknown) => {
		console.error(error);
		process.exit(1);
	},
);
