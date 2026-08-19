import { describe, expect, it } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const paramsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../params');

type Params = {
	txFeeFixed: number;
	txFeePerByte: number;
	executionUnitPrices: { priceMemory: number; priceSteps: number };
	costModels: Record<string, number[]>;
};

function load(network: string): Params {
	return JSON.parse(fs.readFileSync(path.join(paramsDir, `${network}.json`), 'utf8')) as Params;
}

describe('shipped L2 ledger params', () => {
	it('ships preprod', () => {
		expect(fs.existsSync(path.join(paramsDir, 'preprod.json'))).toBe(true);
	});

	// A head charges nothing. A non-zero fee here would make in-head
	// transactions cost real value that nobody collects.
	it('charges no fees', () => {
		const params = load('preprod');
		expect(params.txFeeFixed).toBe(0);
		expect(params.txFeePerByte).toBe(0);
		expect(params.executionUnitPrices.priceMemory).toBe(0);
		expect(params.executionUnitPrices.priceSteps).toBe(0);
	});

	// The V3 model gained entries in the Hydra 2.2.0 era; a file carrying the
	// older 251-entry model against a 297-entry ledger fails every in-head
	// script spend with PPViewHashesDontMatch.
	// These lengths are also asserted against the RUNNING head by
	// src/lib/hydra/hydra/params-drift.ts. Two copies on purpose — src/ does not
	// depend on this package — so change one and change the other.
	it('carries all three Plutus cost models at their pinned lengths', () => {
		const { costModels } = load('preprod');
		expect(Object.keys(costModels).sort()).toEqual(['PlutusV1', 'PlutusV2', 'PlutusV3']);
		expect(costModels.PlutusV1).toHaveLength(166);
		expect(costModels.PlutusV2).toHaveLength(175);
		expect(costModels.PlutusV3).toHaveLength(297);
	});

	it('contains only finite numbers in every cost model', () => {
		const { costModels } = load('preprod');
		for (const [name, values] of Object.entries(costModels)) {
			const bad = values.filter((value) => !Number.isFinite(value));
			expect({ name, bad }).toEqual({ name, bad: [] });
		}
	});

	// Only reviewed networks ship. Generating mainnet from a preprod base would
	// put a real-money head on the wrong chain parameters, so its absence is the
	// intended state until someone supplies verified values.
	it('does not ship an unreviewed mainnet file', () => {
		const hasBase = fs.existsSync(path.join(paramsDir, 'base', 'mainnet.json'));
		const hasGenerated = fs.existsSync(path.join(paramsDir, 'mainnet.json'));
		expect(hasGenerated).toBe(hasBase);
	});

	it('keeps cost models out of the hand-maintained base', () => {
		const base = JSON.parse(fs.readFileSync(path.join(paramsDir, 'base', 'preprod.json'), 'utf8')) as {
			costModels?: unknown;
		};
		expect(base.costModels).toBeUndefined();
	});
});
