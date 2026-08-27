/**
 * Generate the Hydra Host's L2 ledger protocol parameters.
 *
 * WHY THIS LIVES IN payment-source-v2, not in the hydra-host package:
 *
 * The head's ledger must use the same Plutus cost models as the transactions
 * the payment service builds against it. If they diverge, every in-head script
 * spend fails `PPViewHashesDontMatch` — and it fails at commit time, far from
 * the cause. The V2 mesh line is pinned by THIS package
 * (`@meshsdk/core@1.9.0-beta.103`), so importing `@meshsdk/core` from here
 * resolves to exactly the models the V2 builders use. The same import from the
 * repo root would resolve to the V1 line (beta.96) and silently produce the
 * wrong file.
 *
 * That is the whole point: the pin has one home, and the params follow it
 * automatically rather than being hand-copied.
 *
 * Run:  pnpm --filter @masumi/payment-source-v2 run generate:hydra-params
 * Check: ... run generate:hydra-params -- --check     (CI drift guard)
 */

import { DEFAULT_V1_COST_MODEL_LIST, DEFAULT_V2_COST_MODEL_LIST, DEFAULT_V3_COST_MODEL_LIST } from '@meshsdk/core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Networks are discovered from the checked-in base files rather than listed
 * here. A network with no reviewed base is deliberately not generated: shipping
 * preprod-derived values (utxoCostPerByte, protocolVersion, deposits) as
 * mainnet params would configure a real-money head with the wrong ledger.
 */
function networks(): string[] {
	return fs
		.readdirSync(path.join(paramsDir, 'base'))
		.filter((entry) => entry.endsWith('.json'))
		.map((entry) => entry.replace(/\.json$/, ''))
		.sort();
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const paramsDir = path.join(repoRoot, 'packages/hydra-host/params');

/**
 * Read the pin from this package's manifest rather than from the installed
 * module: `@meshsdk/core` does not export its own package.json, and the
 * manifest is the authoritative declaration of the pin anyway.
 */
function meshVersion(): string {
	const manifestPath = path.resolve(here, '../package.json');
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
		dependencies?: Record<string, string>;
	};
	return manifest.dependencies?.['@meshsdk/core'] ?? 'unknown';
}

/** Coerce to plain finite numbers; mesh exposes these as number[] but be strict. */
function costModel(list: readonly unknown[], label: string): number[] {
	return list.map((value, index) => {
		const numeric = typeof value === 'number' ? value : Number(value);
		if (!Number.isFinite(numeric)) {
			throw new Error(`${label}[${index}] is not a finite number: ${String(value)}`);
		}
		return numeric;
	});
}

function build(network: string): string {
	const basePath = path.join(paramsDir, 'base', `${network}.json`);
	const base = JSON.parse(fs.readFileSync(basePath, 'utf8')) as Record<string, unknown>;

	if (base.costModels !== undefined) {
		throw new Error(`${basePath} must not contain costModels; they come from the pinned mesh line`);
	}
	// The L2 ledger charges nothing. Guard it here rather than trusting the base
	// file, because a non-zero fee would make in-head transactions cost real
	// value that no one collects.
	for (const [key, expected] of [
		['txFeeFixed', 0],
		['txFeePerByte', 0],
	] as const) {
		if (base[key] !== expected) {
			throw new Error(`${basePath}: ${key} must be ${expected} for an L2 ledger, found ${String(base[key])}`);
		}
	}

	const params = {
		...base,
		costModels: {
			PlutusV1: costModel(DEFAULT_V1_COST_MODEL_LIST, 'PlutusV1'),
			PlutusV2: costModel(DEFAULT_V2_COST_MODEL_LIST, 'PlutusV2'),
			PlutusV3: costModel(DEFAULT_V3_COST_MODEL_LIST, 'PlutusV3'),
		},
	};
	return `${JSON.stringify(params, null, '\t')}\n`;
}

function main(): void {
	const check = process.argv.includes('--check');
	let drifted = false;

	for (const network of networks()) {
		const target = path.join(paramsDir, `${network}.json`);
		const next = build(network);

		if (check) {
			const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
			if (current !== next) {
				drifted = true;
				console.error(`drift: ${path.relative(repoRoot, target)} is stale for @meshsdk/core@${meshVersion()}`);
			}
			continue;
		}

		fs.writeFileSync(target, next);
		console.log(`wrote ${path.relative(repoRoot, target)} (mesh ${meshVersion()})`);
	}

	if (drifted) {
		console.error('run: pnpm --filter @masumi/payment-source-v2 run generate:hydra-params');
		process.exit(1);
	}
	if (check) {
		console.log(`hydra ledger params are in sync with @meshsdk/core@${meshVersion()}`);
	}
}

main();
