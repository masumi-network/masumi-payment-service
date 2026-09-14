/**
 * Split the purchasing wallet's largest plain-ADA L1 UTxO into a commit
 * candidate + fuel remainder, so 00-open-head.mts can run.
 *
 * Why: 00-open-head commits the SMALLEST UTxO >= 100 ADA and requires a
 * strictly LARGER UTxO to remain as the node's own fuel. A wallet holding one
 * big UTxO satisfies the first rule and fails the second.
 *
 * Keep the commit small: whatever is committed is locked in the head, and with
 * the fanout ex-units blocker it may not come back until that is fixed.
 *
 * Run: BLOCKFROST_API_KEY_PREPROD=... pnpm exec tsx hydra-l2-flow/split-l1-ada.mts [commitAda]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BlockfrostProvider, MeshTxBuilder, MeshWallet } from '@meshsdk/core';

const COMMIT_ADA = BigInt(process.argv[2] ?? '110');
const COMMIT_LOVELACE = COMMIT_ADA * 1_000_000n;
const DIR = join(process.cwd(), 'hydra-l2-flow', 'preprod');

function log(m: string) {
	console.log(`[split-l1] ${new Date().toISOString().slice(11, 19)} ${m}`);
}

async function main() {
	const key =
		process.env.BLOCKFROST_API_KEY_PREPROD?.replace(/"/g, '') ??
		readFileSync(join(DIR, 'blockfrost.txt'), 'utf-8').trim();
	const provider = new BlockfrostProvider(key);

	const { cborHex } = JSON.parse(readFileSync(join(DIR, 'purchasing-cardano.sk'), 'utf-8')) as {
		cborHex: string;
	};
	const wallet = new MeshWallet({
		networkId: 0,
		fetcher: provider,
		submitter: provider,
		key: { type: 'cli', payment: cborHex },
	});
	await (wallet as unknown as { init?: () => Promise<void> }).init?.();
	const addr = wallet.getAddresses().enterpriseAddressBech32!;
	log(`purchasing ${addr}`);

	const utxos = await provider.fetchAddressUTxOs(addr);
	const lovelaceOf = (u: { output: { amount: { unit: string; quantity: string }[] } }) =>
		BigInt(u.output.amount.find((a) => a.unit === 'lovelace')?.quantity ?? '0');
	const plain = utxos.filter((u) => u.output.amount.length === 1);
	const biggest = [...plain].sort((a, b) => (lovelaceOf(b) > lovelaceOf(a) ? 1 : -1))[0];
	if (!biggest) throw new Error('no plain-ADA UTxO found at purchasing');
	const total = lovelaceOf(biggest);
	log(`largest UTxO ${biggest.input.txHash.slice(0, 12)}…#${biggest.input.outputIndex} = ${total} lovelace`);
	if (total < COMMIT_LOVELACE + 5_000_000n) {
		throw new Error(`largest UTxO ${total} is too small to split into ${COMMIT_LOVELACE} + fuel`);
	}

	const builder = new MeshTxBuilder({ fetcher: provider, submitter: provider });
	await builder
		.txIn(biggest.input.txHash, biggest.input.outputIndex, biggest.output.amount, addr)
		.txOut(addr, [{ unit: 'lovelace', quantity: COMMIT_LOVELACE.toString() }])
		.changeAddress(addr)
		.selectUtxosFrom([biggest])
		.complete();
	const signed = await wallet.signTx(builder.txHex, true);
	const txHash = await wallet.submitTx(signed);
	log(`SUBMITTED split: ${txHash}`);
	log(`  commit candidate: ${COMMIT_ADA} ADA, remainder stays as fuel`);
	log('wait ~1-2 min for Blockfrost to confirm, then run 00-open-head.mts');
	process.exit(0);
}

main().catch((e) => {
	console.error('[split-l1] FATAL', e instanceof Error ? e.message : e);
	process.exit(1);
});
