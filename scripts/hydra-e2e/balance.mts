/**
 * Report the on-chain balance behind Cardano key envelopes.
 *
 * Opening a real Head needs each participant's node Cardano key funded: the
 * `Init` transaction and every commit are paid from it. This turns key
 * envelopes into addresses and asks Blockfrost what is there, so "can we open a
 * head" has an answer rather than a guess.
 *
 *   pnpm exec tsx scripts/hydra-e2e/balance.mts <file.vk|file.sk> [...]
 *
 * Test support only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { addressFromEnvelope, ada, balanceOf, readEnvelope } from './cardano.mjs';
import { BLOCKFROST_PROJECT_FILE } from './env.mjs';

async function main(): Promise<void> {
	const files = process.argv.slice(2);
	if (files.length === 0) {
		console.error('usage: balance.mts <file.vk|file.sk> [...]');
		process.exit(1);
	}
	const projectId = fs.readFileSync(BLOCKFROST_PROJECT_FILE, 'utf8').trim();

	for (const file of files) {
		const address = await addressFromEnvelope(readEnvelope(file));
		const balance = await balanceOf(address, projectId);
		console.log(`${path.basename(file).padEnd(26)} ${address}`);
		console.log(
			`${''.padEnd(26)} ${ada(balance.lovelace)} in ${balance.utxos} utxo(s), ` +
				`${balance.pureAdaUtxos} of them pure ADA`,
		);
	}
}

main().catch((error: unknown) => {
	console.error((error as Error).stack ?? (error as Error).message);
	process.exit(1);
});
