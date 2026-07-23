import { describe, it, expect } from '@jest/globals';
import { aggregateInHeadAmounts } from './hydra-head-balance';

describe('aggregateInHeadAmounts', () => {
	it('returns empty for no UTxOs', () => {
		expect(aggregateInHeadAmounts([])).toEqual([]);
	});

	it('sums lovelace across multiple UTxOs and reports ADA as unit ""', () => {
		expect(
			aggregateInHeadAmounts([[{ unit: 'lovelace', quantity: '5000000' }], [{ unit: '', quantity: '3000000' }]]),
		).toEqual([{ unit: '', quantity: '8000000' }]);
	});

	it('normalises lovelace and empty-string to the same ADA bucket', () => {
		expect(aggregateInHeadAmounts([[{ unit: 'LoveLace', quantity: '1' }], [{ unit: '', quantity: '2' }]])).toEqual([
			{ unit: '', quantity: '3' },
		]);
	});

	it('aggregates native tokens per unit and orders ADA first then tokens', () => {
		const tok = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';
		const result = aggregateInHeadAmounts([
			[
				{ unit: 'lovelace', quantity: '10000000' },
				{ unit: tok, quantity: '400' },
			],
			[{ unit: tok, quantity: '600' }],
		]);
		expect(result).toEqual([
			{ unit: '', quantity: '10000000' },
			{ unit: tok, quantity: '1000' },
		]);
	});

	it('drops assets that net to zero', () => {
		// (No real UTxO has a zero quantity, but the filter guards it.)
		expect(aggregateInHeadAmounts([[{ unit: 'policy.a', quantity: '0' }]])).toEqual([]);
	});

	it('skips malformed quantities without throwing', () => {
		expect(
			aggregateInHeadAmounts([[{ unit: 'lovelace', quantity: 'not-a-number' }], [{ unit: 'lovelace', quantity: '5' }]]),
		).toEqual([{ unit: '', quantity: '5' }]);
	});

	it('orders multiple tokens deterministically by unit', () => {
		const result = aggregateInHeadAmounts([
			[
				{ unit: 'bbbb', quantity: '1' },
				{ unit: 'aaaa', quantity: '2' },
			],
		]);
		expect(result.map((a) => a.unit)).toEqual(['aaaa', 'bbbb']);
	});
});
