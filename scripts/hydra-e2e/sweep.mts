/**
 * Recover funds from a node's Cardano key.
 *
 * The head-init phase funds each node's address so it can pay for `Init`.
 * Whatever is left belongs back in the harness wallet, and the only thing that
 * can move it is the node's own signing key — which lives under the Host's data
 * directory and is destroyed when the next run wipes it.
 *
 *   pnpm exec tsx scripts/hydra-e2e/sweep.mts <cardano.sk> [destination]
 *
 * Destination defaults to the address behind the funding key.
 *
 * Test support only.
 */

import fs from 'node:fs';
import { addressFromEnvelope, ada, balanceOf, rawKeyHex, readEnvelope } from './cardano.mjs';
import { BLOCKFROST_PROJECT_FILE, FUNDING_SIGNING_KEY_FILE } from './env.mjs';

async function main(): Promise<void> {
	const [keyFile, destinationArg] = process.argv.slice(2);
	if (keyFile === undefined) {
		console.error('usage: sweep.mts <cardano.sk> [destination address]');
		process.exit(1);
	}

	const projectId = fs.readFileSync(BLOCKFROST_PROJECT_FILE, 'utf8').trim();
	const envelope = readEnvelope(keyFile);
	const source = await addressFromEnvelope(envelope);
	const destination = destinationArg ?? (await addressFromEnvelope(readEnvelope(FUNDING_SIGNING_KEY_FILE)));

	const before = await balanceOf(source, projectId);
	console.log(`source      ${source}`);
	console.log(`            ${ada(before.lovelace)} in ${before.utxos} utxo(s)`);
	if (before.lovelace === 0n) {
		console.log('nothing to sweep');
		return;
	}
	console.log(`destination ${destination}`);

	const { BlockfrostProvider, MeshTxBuilder, MeshWallet } = await import('@meshsdk/core');
	const provider = new BlockfrostProvider(projectId);
	const wallet = new MeshWallet({
		networkId: 0,
		fetcher: provider,
		submitter: provider,
		key: { type: 'cli', payment: rawKeyHex(envelope.cborHex) },
	});
	await wallet.init();

	// A `cli` MeshWallet derives a base address from the payment key, but these
	// funds sit at the enterprise address of the same key hash — so the inputs
	// and the change address have to be named explicitly. The witness is valid
	// for both, since they share one payment credential.
	const utxos = await provider.fetchAddressUTxOs(source);
	const builder = new MeshTxBuilder({ fetcher: provider, submitter: provider, verbose: false });
	const unsigned = await builder.changeAddress(destination).selectUtxosFrom(utxos).complete();
	const signed = await wallet.signTx(unsigned, true);
	console.log(`swept in ${await wallet.submitTx(signed)}`);
}

main().catch((error: unknown) => {
	// Mesh throws plain objects for provider failures, so a bare `.message`
	// prints `undefined` and hides the actual reason.
	console.error(error instanceof Error ? (error.stack ?? error.message) : JSON.stringify(error));
	process.exit(1);
});
