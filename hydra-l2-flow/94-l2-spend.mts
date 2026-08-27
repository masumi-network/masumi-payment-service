/**
 * L2-resume probe — build and submit an in-head transfer from an EXPLICITLY
 * NAMED UTxO (no /snapshot/utxo fetch). Used after a persistence wipe + chain
 * replay, where the confirmed-snapshot view is empty but localUTxO may still
 * hold the replayed deposit outputs. The node's accept/reject answer is the
 * measurement.
 *
 * Run: pnpm exec tsx hydra-l2-flow/94-l2-spend.mts \
 *        <txHash> <index> <lovelace> <ownerAddr> <skPathInContainer> <destAddr> <sendLovelace> [nodePort]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MeshTxBuilder } from '@meshsdk/core';
import { HydraNode } from '@/lib/hydra/hydra/node';
import { HydraProvider } from '@/lib/hydra/hydra/provider';

const [txHash, indexStr, lovelace, ownerAddr, skPath, destAddr, sendLovelace, nodePort] = process.argv.slice(2);
if (!sendLovelace) {
	console.error(
		'usage: 94-l2-spend.mts <txHash> <index> <lovelace> <ownerAddr> <skPathInContainer> <destAddr> <sendLovelace> [nodePort]',
	);
	process.exit(2);
}
const PORT = nodePort ?? '4001';
const CARDANO_NODE_IMAGE = 'ghcr.io/intersectmbo/cardano-node:10.6.2';

function log(m: string) {
	console.log(`[l2-spend] ${new Date().toISOString().slice(11, 19)} ${m}`);
}

function signWithCardanoCli(cborHex: string): string {
	const tmpIn = join(tmpdir(), `l2s-draft-${Date.now()}.tx`);
	writeFileSync(tmpIn, JSON.stringify({ type: 'Tx ConwayEra', description: '', cborHex }));
	try {
		const preprodDir = join(process.cwd(), 'hydra-l2-flow', 'preprod');
		const signedJson = execFileSync(
			'docker',
			[
				'run',
				'--rm',
				'-i',
				'-v',
				`${preprodDir}:/keys`,
				'--entrypoint',
				'sh',
				CARDANO_NODE_IMAGE,
				'-c',
				`cat > /tmp/d.tx && cardano-cli conway transaction sign --tx-file /tmp/d.tx --signing-key-file ${skPath} --testnet-magic 1 --out-file /tmp/s.tx && cat /tmp/s.tx`,
			],
			{ input: readFileSync(tmpIn, 'utf-8'), encoding: 'utf-8' },
		);
		return (JSON.parse(signedJson) as { cborHex: string }).cborHex;
	} finally {
		try {
			unlinkSync(tmpIn);
		} catch {
			/* ignore */
		}
	}
}

async function main() {
	const node = new HydraNode({ httpUrl: `http://127.0.0.1:${PORT}` });
	node.connect();
	await new Promise((r) => setTimeout(r, 1500));
	const provider = new HydraProvider({ node });
	await new Promise((r) => setTimeout(r, 600));

	const amountList = [{ unit: 'lovelace', quantity: lovelace }];
	const tx = new MeshTxBuilder({ fetcher: provider, submitter: provider, isHydra: true });
	await tx
		.txIn(txHash, Number(indexStr), amountList, ownerAddr)
		.txOut(destAddr, [{ unit: 'lovelace', quantity: sendLovelace }])
		.setFee('0')
		.changeAddress(ownerAddr)
		.complete();
	log(`draft built from ${txHash.slice(0, 12)}…#${indexStr}`);

	const signed = signWithCardanoCli(tx.txHex);
	log('signed; submitting to node…');
	try {
		const submittedHash = await provider.submitTx(signed);
		log(`SUBMITTED OK: ${submittedHash}`);
		const confirmed = await Promise.race([
			node.awaitTx(submittedHash, 500).then(() => true),
			new Promise<boolean>((r) => setTimeout(() => r(false), 20000)),
		]);
		log(`confirmed in snapshot: ${confirmed}`);
		process.exit(confirmed ? 0 : 3);
	} catch (e) {
		log(`SUBMIT REJECTED: ${e instanceof Error ? e.message : String(e)}`);
		process.exit(4);
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
