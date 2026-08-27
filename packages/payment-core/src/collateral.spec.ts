import { describe, expect, it } from '@jest/globals';

import { MIN_TOTAL_COLLATERAL_LOVELACE, deriveTotalCollateral, extractCollateralProtocolParams } from './collateral';

const BUDGET = [{ mem: 14_000_000, steps: 10_000_000_000 }];

/**
 * `deriveTotalCollateral` degrades to the floor when it cannot read the protocol
 * parameters, which is safe but throws away the scaling that is the whole point
 * of deriving. The degradation is invisible in a passing suite, so the shape
 * PRODUCTION passes has to be asserted directly.
 *
 * Production hands it mesh's `Protocol`, whose field is `collateralPercent`
 * (@meshsdk/common `index.d.ts:214`) with numeric prices. Every other test in the
 * repo uses the `collateralPercentage` alias with string prices, so without these
 * a mesh rename would silently pin every build back to the 3 ADA floor.
 */
describe('extractCollateralProtocolParams', () => {
	it("reads mesh's own Protocol shape, the one production passes", () => {
		expect(extractCollateralProtocolParams({ priceMem: 0.0577, priceStep: 0.0000721, collateralPercent: 150 })).toEqual(
			{ priceMem: 0.0577, priceStep: 0.0000721, collateralPercentage: 150 },
		);
	});

	it('reads the raw blockfrost snake_case shape', () => {
		expect(
			extractCollateralProtocolParams({ price_mem: '0.0577', price_step: '0.0000721', collateral_percent: 150 }),
		).toEqual({ priceMem: '0.0577', priceStep: '0.0000721', collateralPercentage: 150 });
	});

	it('returns null when a required field is absent', () => {
		expect(extractCollateralProtocolParams({ priceMem: 0.0577, priceStep: 0.0000721 })).toBeNull();
	});
});

describe('deriveTotalCollateral', () => {
	/**
	 * The regression this guards: with mesh's key names the derivation must scale
	 * above the floor. If it returns exactly the floor here, the extractor stopped
	 * recognising the shape and every build is back to a flat 3 ADA.
	 */
	it("scales above the floor on mesh's Protocol shape", () => {
		const total = deriveTotalCollateral(
			BUDGET,
			{ priceMem: 0.0577, priceStep: 0.0000721, collateralPercent: 150 },
			10_000_000n,
		);

		expect(BigInt(total)).toBe(3_439_800n);
		expect(BigInt(total)).toBeGreaterThan(MIN_TOTAL_COLLATERAL_LOVELACE);
	});

	it('falls back to the floor when the parameters cannot be read', () => {
		expect(deriveTotalCollateral(BUDGET, { priceMem: 0.0577 }, 10_000_000n)).toBe(
			MIN_TOTAL_COLLATERAL_LOVELACE.toString(),
		);
	});

	it('never declares more than the input can return', () => {
		const total = deriveTotalCollateral(
			BUDGET,
			{ priceMem: 0.0577, priceStep: 0.0000721, collateralPercent: 150 },
			4_200_000n,
		);

		expect(BigInt(total)).toBe(3_200_000n);
		expect(BigInt(total)).toBeLessThan(4_200_000n);
	});
});
