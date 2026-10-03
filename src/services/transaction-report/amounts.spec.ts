import { describe, expect, it } from '@jest/globals';
import {
	accumulateAmounts,
	addAmounts,
	createAmountAccumulator,
	getAtomicAmount,
	materializeAmounts,
	normalizeAmounts,
	subtractAmounts,
} from './amounts';

describe('transaction report amount arithmetic', () => {
	it('normalizes and merges duplicate asset units without changing the input', () => {
		const values = [
			{ unit: '', amount: 2n },
			{ unit: 'lovelace', amount: 3n },
			{ unit: 'policyasset', amount: 4n },
		];

		expect(normalizeAmounts(values)).toEqual([
			{ unit: 'lovelace', amount: 5n },
			{ unit: 'policyasset', amount: 4n },
		]);
		expect(values[0]).toEqual({ unit: '', amount: 2n });
	});

	it('drops exact zero entries', () => {
		expect(
			normalizeAmounts([
				{ unit: 'lovelace', amount: 2n },
				{ unit: '', amount: -2n },
			]),
		).toEqual([]);
	});

	it('adds asset lists with BigInt precision', () => {
		expect(addAmounts([{ unit: 'lovelace', amount: 9_007_199_254_740_993n }], [{ unit: '', amount: 7n }])).toEqual([
			{ unit: 'lovelace', amount: 9_007_199_254_741_000n },
		]);
	});

	it('subtracts assets and preserves negative balances', () => {
		expect(
			subtractAmounts(
				[{ unit: 'policyasset', amount: 10n }],
				[
					{ unit: 'policyasset', amount: 4n },
					{ unit: 'lovelace', amount: 2n },
				],
			),
		).toEqual([
			{ unit: 'lovelace', amount: -2n },
			{ unit: 'policyasset', amount: 6n },
		]);
	});

	it('returns zero for an absent unit', () => {
		expect(getAtomicAmount([{ unit: 'lovelace', amount: 5n }], 'policyasset')).toBe(0n);
	});

	it('accumulates growing asset sets and sorts only when materialized', () => {
		const accumulator = createAmountAccumulator();
		accumulateAmounts(accumulator, [
			{ unit: 'policy-b', amount: 2n },
			{ unit: '', amount: 3n },
		]);
		accumulateAmounts(accumulator, [
			{ unit: 'policy-a', amount: 4n },
			{ unit: 'lovelace', amount: -1n },
		]);

		expect(materializeAmounts(accumulator)).toEqual([
			{ unit: 'lovelace', amount: 2n },
			{ unit: 'policy-a', amount: 4n },
			{ unit: 'policy-b', amount: 2n },
		]);
	});
});
