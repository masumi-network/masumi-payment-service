import { MAX_COLLATERAL_PREP_FAILURES, prepFailureThresholdReached } from './prep-failure-guard';

describe('prepFailureThresholdReached', () => {
	it('is false below the threshold', () => {
		expect(prepFailureThresholdReached(0)).toBe(false);
		expect(prepFailureThresholdReached(1)).toBe(false);
		expect(prepFailureThresholdReached(MAX_COLLATERAL_PREP_FAILURES - 1)).toBe(false);
	});

	it('is true at and above the threshold', () => {
		expect(prepFailureThresholdReached(MAX_COLLATERAL_PREP_FAILURES)).toBe(true);
		expect(prepFailureThresholdReached(MAX_COLLATERAL_PREP_FAILURES + 5)).toBe(true);
	});

	it('threshold is a positive integer (a transient blip must not trip it immediately)', () => {
		expect(Number.isInteger(MAX_COLLATERAL_PREP_FAILURES)).toBe(true);
		expect(MAX_COLLATERAL_PREP_FAILURES).toBeGreaterThan(1);
	});
});
