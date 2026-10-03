/**
 * Fail the build when a head's ledger has drifted from the chain it settles on.
 *
 * The parameter files under `packages/hydra-host/params` are a snapshot: a copy
 * of the network's parameters with only the cost knobs zeroed, taken by hand and
 * then frozen. A head initialised from a stale copy can create outputs that L1
 * will refuse to accept back at fanout, and there is no way to add value to an
 * output on its way out — the head simply cannot be settled.
 *
 * Checking it here means the divergence is caught before anyone opens a head
 * across it. There is no margin that saves an operator who never finds out.
 *
 *   BLOCKFROST_API_KEY_PREPROD=… pnpm exec tsx scripts/check-hydra-params-drift.mts
 *
 * Skips with a zero exit when no key is configured, so forks and local runs are
 * not blocked by a secret they do not have.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describeParamDrift, findParamDrift } from '../src/utils/hydra/params-drift';

type Network = { name: string; key: string | undefined; host: string };

const NETWORKS: Network[] = [
	{
		name: 'preprod',
		key: process.env.BLOCKFROST_API_KEY_PREPROD,
		host: 'https://cardano-preprod.blockfrost.io/api/v0',
	},
	{
		name: 'mainnet',
		key: process.env.BLOCKFROST_API_KEY_MAINNET,
		host: 'https://cardano-mainnet.blockfrost.io/api/v0',
	},
];

function headParamsFor(network: string): { utxoCostPerByte: number; maxValueSize: number } | null {
	const file = path.join(process.cwd(), 'packages/hydra-host/params', `${network}.json`);
	if (!existsSync(file)) return null;
	const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
	const utxoCostPerByte = parsed.utxoCostPerByte;
	const maxValueSize = parsed.maxValueSize;
	if (typeof utxoCostPerByte !== 'number' || typeof maxValueSize !== 'number') {
		throw new Error(`${network}.json is missing utxoCostPerByte or maxValueSize`);
	}
	return { utxoCostPerByte, maxValueSize };
}

async function chainParamsFor(network: Network): Promise<{ utxoCostPerByte: number; maxValueSize: number }> {
	const response = await fetch(`${network.host}/epochs/latest/parameters`, {
		headers: { project_id: network.key ?? '' },
	});
	if (!response.ok) {
		throw new Error(`Blockfrost answered ${response.status} for ${network.name}`);
	}
	const body = (await response.json()) as { coins_per_utxo_size?: string | number; max_val_size?: string | number };
	return {
		utxoCostPerByte: Number(body.coins_per_utxo_size),
		maxValueSize: Number(body.max_val_size),
	};
}

async function main(): Promise<void> {
	let blocking = 0;
	let checked = 0;

	for (const network of NETWORKS) {
		const head = headParamsFor(network.name);
		if (head === null) {
			console.log(`· ${network.name}: no params file, nothing to check`);
			continue;
		}
		if (!network.key) {
			console.log(`· ${network.name}: no Blockfrost key configured, skipping`);
			continue;
		}
		checked += 1;
		const chain = await chainParamsFor(network);
		const drift = findParamDrift(head, chain);
		if (drift.length === 0) {
			console.log(`✓ ${network.name}: head ledger matches the chain`);
			continue;
		}
		const fatal = drift.filter((entry) => entry.blocksFanout);
		blocking += fatal.length;
		console.log(`${fatal.length > 0 ? '✗' : '!'} ${network.name}: ${describeParamDrift(drift)}`);
	}

	if (checked === 0) {
		console.log('no network could be checked; treating as a skip rather than a pass');
		return;
	}
	if (blocking > 0) {
		// Only the fanout-blocking direction fails. A head stricter than the chain
		// is worth reporting and worth fixing, but it strands nothing.
		throw new Error(
			`${blocking} parameter(s) have moved in the direction that can leave a head unsettleable. ` +
				'Regenerate the params file before opening any new head.',
		);
	}
}

main().then(
	() => process.exit(0),
	(error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	},
);
