/**
 * Noticing when a head's ledger stops being the ledger we build against.
 *
 * The companion to protocol-drift.ts, which watches the shape of what the node
 * says. This watches the parameters it says it is running, because those decide
 * whether a transaction this service builds is even valid inside the head.
 *
 * Two of them have already cost real time:
 *
 *  - Cost models. The head hashes its own arrays into the script-data-hash, so
 *    a head whose models differ from the pinned mesh line fails every in-head
 *    script spend with `PPViewHashesDontMatch` — and it fails at commit time,
 *    far from the cause. See docs/adr/0005-meshsdk-version-pinning-v1-v2.md.
 *  - Execution units and `maxTxSize`. These bound what can eventually be fanned
 *    out. An L2 ledger that permits a larger transaction than L1 lets a head
 *    accept an output that no fanout transaction can ever distribute, because a
 *    fanout chunk cannot be smaller than one output. That is not recoverable
 *    after close.
 *
 * Like protocol-drift, this reports and never refuses. Refusing on a parameter
 * change would take down a head that is working; the value here is that someone
 * hears about it while it still is.
 *
 * The expected values below are a hand-maintained claim about the ledger we
 * ship in packages/hydra-host/params/. Changing one is a claim that the change
 * was intended — the generator and ledger-params.spec.ts guard the file itself,
 * and this guards the head actually running.
 */

import { logger } from '@masumi/payment-core/logger';
import {
	getOwnPlainObject,
	getOwnValue,
	isPlainObject,
	type RuntimeObject,
} from '@masumi/payment-core/object-properties';

/**
 * Entry counts per Plutus language, which is the cheap structural signal.
 *
 * A length change means a different Plutus era or a different mesh line, which
 * is the case that silently breaks script-data-hash. Comparing full contents
 * here is deliberately not done: this module is V1-pinned like the rest of
 * `src/`, so it cannot import the V2 arrays the head is configured with without
 * resolving to the wrong ones.
 *
 * These same counts are asserted against the shipped file in
 * `packages/hydra-host/src/ledger-params.spec.ts`. Kept as two copies on
 * purpose: `src/` does not otherwise depend on `@masumi/hydra-host`, and a new
 * cross-package dependency costs more than three integers are worth. Change one
 * and change the other.
 */
export const EXPECTED_COST_MODEL_LENGTHS: ReadonlyMap<string, number> = new Map([
	['PlutusV1', 166],
	['PlutusV2', 175],
	['PlutusV3', 297],
]);

/** Matches L1. A head permitting more than L1 can accept an unfanoutable output. */
export const EXPECTED_MAX_TX_SIZE = 16_384;

export const EXPECTED_TX_EXECUTION_UNITS = { memory: 16_500_000, steps: 10_000_000_000 } as const;

/** The L2 ledger charges nothing; a non-zero value costs real value no one collects. */
export const EXPECTED_ZERO_FIELDS = ['txFeeFixed', 'txFeePerByte'] as const;

export type ParamsDrift = {
	/** Stable identifier, so a given drift is reported once per connection. */
	key: string;
	/** Operator-facing phrase naming what changed. */
	detail: string;
};

function readNumber(source: RuntimeObject | undefined, field: string): number | null {
	if (source === undefined) return null;
	const value = getOwnValue(source, field);
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function compareNumber(
	drift: ParamsDrift[],
	key: string,
	label: string,
	observed: number | null,
	expected: number,
): void {
	if (observed === null || observed === expected) return;
	drift.push({ key, detail: `${label} is ${observed}, expected ${expected}` });
}

function detectCostModelDrift(params: RuntimeObject): ParamsDrift[] {
	const drift: ParamsDrift[] = [];
	const costModels = getOwnPlainObject(params, 'costModels');
	if (costModels === undefined) {
		// Absent entirely is worth saying: hydra's convertCostModels drops a model
		// it cannot convert rather than failing, so silence here is a real state.
		return [{ key: 'costModels', detail: 'the head reports no cost models at all' }];
	}

	for (const [language, expected] of EXPECTED_COST_MODEL_LENGTHS) {
		const model = getOwnValue(costModels, language);
		if (model === undefined) {
			drift.push({ key: `costModels.${language}`, detail: `${language} is missing from the head's cost models` });
			continue;
		}
		if (!Array.isArray(model)) {
			drift.push({ key: `costModels.${language}`, detail: `${language} is not an array of parameters` });
			continue;
		}
		if (model.length !== expected) {
			drift.push({
				key: `costModels.${language}.length`,
				detail: `${language} carries ${model.length} parameters, expected ${expected}`,
			});
		}
	}

	for (const language of Object.keys(costModels)) {
		if (!EXPECTED_COST_MODEL_LENGTHS.has(language)) {
			drift.push({ key: `costModels.${language}`, detail: `${language} is a language this service does not model` });
		}
	}

	return drift;
}

/**
 * Every way the head's parameters differ from the ledger we ship.
 *
 * Empty for a head started from packages/hydra-host/params/. Takes `unknown`
 * and guards its way in, because this runs against another process's JSON and
 * a malformed payload must not throw on a path that only reports.
 */
export function detectParamsDrift(params: unknown): ParamsDrift[] {
	if (!isPlainObject(params)) return [];
	const source = params;

	const drift: ParamsDrift[] = [...detectCostModelDrift(source)];

	// Reported when absent, unlike the fields below. A head that stops naming its
	// maxTxSize is indistinguishable from one that matches under the usual
	// ignore-what-you-cannot-read rule — and this is the field that decides
	// whether the head can accept an output no fanout transaction can distribute.
	const maxTxSize = readNumber(source, 'maxTxSize');
	if (maxTxSize === null) {
		// "No usable" rather than "no": readNumber also rejects a present but
		// non-finite value, and reporting that one as absent would send whoever
		// reads this looking for a missing field.
		drift.push({ key: 'maxTxSize', detail: 'the head reports no usable maxTxSize' });
	} else {
		compareNumber(drift, 'maxTxSize', 'maxTxSize', maxTxSize, EXPECTED_MAX_TX_SIZE);
	}

	const executionUnits = getOwnPlainObject(source, 'maxTxExecutionUnits');
	compareNumber(
		drift,
		'maxTxExecutionUnits.memory',
		'maxTxExecutionUnits.memory',
		readNumber(executionUnits, 'memory'),
		EXPECTED_TX_EXECUTION_UNITS.memory,
	);
	compareNumber(
		drift,
		'maxTxExecutionUnits.steps',
		'maxTxExecutionUnits.steps',
		readNumber(executionUnits, 'steps'),
		EXPECTED_TX_EXECUTION_UNITS.steps,
	);

	for (const field of EXPECTED_ZERO_FIELDS) {
		compareNumber(drift, field, field, readNumber(source, field), 0);
	}

	const prices = getOwnPlainObject(source, 'executionUnitPrices');
	compareNumber(drift, 'executionUnitPrices.priceMemory', 'priceMemory', readNumber(prices, 'priceMemory'), 0);
	compareNumber(drift, 'executionUnitPrices.priceSteps', 'priceSteps', readNumber(prices, 'priceSteps'), 0);

	return drift;
}

/** One operator-facing line naming what changed and why it is worth looking at. */
export function describeParamsDrift(drift: readonly ParamsDrift[]): string {
	return (
		`This head's ledger parameters differ from the ones this service builds against ` +
		`(${drift.map((entry) => entry.detail).join('; ')}). ` +
		'Nothing is broken yet and the head keeps running, but a cost-model difference fails every in-head script ' +
		'spend with PPViewHashesDontMatch at commit time, and a maxTxSize above L1 lets the head accept an output no ' +
		'fanout transaction can distribute. Check packages/hydra-host/params/ against the running node before ' +
		'sending anything else through this head.'
	);
}

/**
 * Report parameter drift once per key, for the lifetime of `seen`.
 *
 * Deduplicated because parameters are fetched per operation, not once: without
 * this a single misconfigured head would repeat the same warning for every
 * transaction it ever builds.
 */
export function reportParamsDrift(params: unknown, seen: Set<string>): void {
	const fresh = detectParamsDrift(params).filter((entry) => !seen.has(entry.key));
	if (fresh.length === 0) return;
	for (const entry of fresh) seen.add(entry.key);
	logger.warn(`[HydraNode] ${describeParamsDrift(fresh)}`);
}
