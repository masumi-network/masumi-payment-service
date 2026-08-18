import { describe, expect, it, jest } from '@jest/globals';

const mockWarn = jest.fn();

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { debug: jest.fn(), info: jest.fn(), warn: mockWarn, error: jest.fn() },
}));

const {
	detectParamsDrift,
	describeParamsDrift,
	reportParamsDrift,
	markDriftReported,
	MAX_REPORTED_DRIFT_KEYS,
	EXPECTED_MAX_TX_SIZE,
	EXPECTED_TX_EXECUTION_UNITS,
} = await import('./params-drift');

/** The ledger we ship, as packages/hydra-host/params/preprod.json carries it. */
function shippedParams(): Record<string, unknown> {
	return {
		maxTxSize: EXPECTED_MAX_TX_SIZE,
		maxTxExecutionUnits: { ...EXPECTED_TX_EXECUTION_UNITS },
		txFeeFixed: 0,
		txFeePerByte: 0,
		executionUnitPrices: { priceMemory: 0, priceSteps: 0 },
		costModels: {
			PlutusV1: new Array(166).fill(1),
			PlutusV2: new Array(175).fill(1),
			PlutusV3: new Array(297).fill(1),
		},
	};
}

describe('detectParamsDrift', () => {
	it('is silent for the ledger we ship', () => {
		expect(detectParamsDrift(shippedParams())).toEqual([]);
	});

	it('catches a cost model at the wrong length', () => {
		const params = shippedParams();
		// The 350-entry chain model against our 297-entry pinned mesh line: the
		// exact substitution that fails every in-head script spend.
		(params.costModels as Record<string, unknown>).PlutusV3 = new Array(350).fill(1);

		const drift = detectParamsDrift(params);

		expect(drift).toHaveLength(1);
		expect(drift[0]?.key).toBe('costModels.PlutusV3.length');
		expect(drift[0]?.detail).toContain('350');
		expect(drift[0]?.detail).toContain('297');
	});

	it('catches a missing cost model, which hydra drops silently rather than failing', () => {
		const params = shippedParams();
		delete (params.costModels as Record<string, unknown>).PlutusV3;

		expect(detectParamsDrift(params)).toEqual([
			{ key: 'costModels.PlutusV3', detail: "PlutusV3 is missing from the head's cost models" },
		]);
	});

	it('reports cost models absent entirely', () => {
		const params = shippedParams();
		delete params.costModels;

		expect(detectParamsDrift(params)).toEqual([
			{ key: 'costModels', detail: 'the head reports no cost models at all' },
		]);
	});

	it('catches a language we do not model', () => {
		const params = shippedParams();
		(params.costModels as Record<string, unknown>).PlutusV4 = new Array(400).fill(1);

		const drift = detectParamsDrift(params);

		expect(drift).toHaveLength(1);
		expect(drift[0]?.key).toBe('costModels.PlutusV4');
	});

	it('catches a maxTxSize above L1, which is what makes an output unfanoutable', () => {
		const params = shippedParams();
		params.maxTxSize = 32_768;

		const drift = detectParamsDrift(params);

		expect(drift).toHaveLength(1);
		expect(drift[0]?.key).toBe('maxTxSize');
		expect(drift[0]?.detail).toContain('32768');
	});

	it('catches execution unit changes on both axes', () => {
		const params = shippedParams();
		params.maxTxExecutionUnits = { memory: 14_000_000, steps: 20_000_000_000 };

		const keys = detectParamsDrift(params).map((entry) => entry.key);

		expect(keys).toEqual(['maxTxExecutionUnits.memory', 'maxTxExecutionUnits.steps']);
	});

	it('catches an L2 ledger that would charge fees', () => {
		const params = shippedParams();
		params.txFeeFixed = 155_381;
		(params.executionUnitPrices as Record<string, unknown>).priceSteps = 0.0000721;

		const keys = detectParamsDrift(params).map((entry) => entry.key);

		expect(keys).toEqual(['txFeeFixed', 'executionUnitPrices.priceSteps']);
	});

	it('does not throw on a malformed payload, since it only reports', () => {
		expect(detectParamsDrift(null)).toEqual([]);
		expect(detectParamsDrift('not params')).toEqual([]);
		expect(detectParamsDrift([])).toEqual([]);
		expect(detectParamsDrift({ costModels: { PlutusV1: 'not an array' } })).toContainEqual({
			key: 'costModels.PlutusV1',
			detail: 'PlutusV1 is not an array of parameters',
		});
	});

	it('reports an absent maxTxSize instead of treating it as a match', () => {
		// The one field exempt from ignore-what-you-cannot-read: it decides whether
		// the head can accept an output no fanout transaction can distribute.
		const params = shippedParams();
		delete params.maxTxSize;

		expect(detectParamsDrift(params)).toEqual([{ key: 'maxTxSize', detail: 'the head reports no usable maxTxSize' }]);
	});

	it('reports a present but unreadable maxTxSize the same way', () => {
		// Wording says "no usable" rather than "no" precisely so this case does not
		// send someone hunting for a field that is right there.
		const params = shippedParams();
		params.maxTxSize = Number.POSITIVE_INFINITY;

		expect(detectParamsDrift(params)).toEqual([{ key: 'maxTxSize', detail: 'the head reports no usable maxTxSize' }]);
	});

	it('ignores fields it cannot read rather than inventing drift', () => {
		// A field absent or non-numeric is a payload we do not understand, which
		// is protocol-drift's job to notice. Reporting it here as a value change
		// would be a false positive on every older node. maxTxSize is the one
		// exception and is asserted separately above.
		const params = shippedParams();
		delete params.maxTxExecutionUnits;
		delete params.txFeeFixed;
		delete params.executionUnitPrices;

		expect(detectParamsDrift(params)).toEqual([]);
	});
});

describe('describeParamsDrift', () => {
	it('names every difference and what to check', () => {
		const message = describeParamsDrift([{ key: 'maxTxSize', detail: 'maxTxSize is 32768, expected 16384' }]);

		expect(message).toContain('maxTxSize is 32768, expected 16384');
		expect(message).toContain('PPViewHashesDontMatch');
		expect(message).toContain('packages/hydra-host/params/');
	});
});

describe('reportParamsDrift', () => {
	it('warns once per key however often parameters are fetched', () => {
		mockWarn.mockClear();
		const seen = new Set<string>();
		const params = shippedParams();
		params.maxTxSize = 32_768;

		reportParamsDrift(params, seen);
		reportParamsDrift(params, seen);
		reportParamsDrift(params, seen);

		expect(mockWarn).toHaveBeenCalledTimes(1);
	});

	it('still reports a second, different drift on the same head', () => {
		mockWarn.mockClear();
		const seen = new Set<string>();
		const params = shippedParams();
		params.maxTxSize = 32_768;

		reportParamsDrift(params, seen);
		params.txFeeFixed = 155_381;
		reportParamsDrift(params, seen);

		expect(mockWarn).toHaveBeenCalledTimes(2);
	});

	it('says nothing for the ledger we ship', () => {
		mockWarn.mockClear();

		reportParamsDrift(shippedParams(), new Set<string>());

		expect(mockWarn).not.toHaveBeenCalled();
	});
	// The keys come from the node — an unmodelled cost-model language is reported
	// under its own name — and the set lives as long as the node object.
	it('stops recording once a node has named more keys than the cap', () => {
		const seen = new Set<string>();

		for (let index = 0; index < MAX_REPORTED_DRIFT_KEYS + 50; index += 1) {
			const params = shippedParams();
			const costModels = params.costModels as Record<string, unknown>;
			costModels[`PlutusMade${index}`] = [];
			reportParamsDrift(params, seen);
		}

		expect(seen.size).toBe(MAX_REPORTED_DRIFT_KEYS);
	});

	it('reports a key once and refuses to record past the cap', () => {
		const seen = new Set<string>();
		expect(markDriftReported(seen, 'costModels.PlutusV9')).toBe(true);
		expect(markDriftReported(seen, 'costModels.PlutusV9')).toBe(false);

		for (let index = 0; index < MAX_REPORTED_DRIFT_KEYS; index += 1) markDriftReported(seen, `filler-${index}`);

		expect(seen.size).toBe(MAX_REPORTED_DRIFT_KEYS);
		expect(markDriftReported(seen, 'costModels.PlutusV10')).toBe(false);
	});
});
