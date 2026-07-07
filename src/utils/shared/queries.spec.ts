import { buildTransactionSearchFilter, parseAmountSearchRange } from './queries';

describe('buildTransactionSearchFilter', () => {
	it('includes agentName in search OR clauses', () => {
		const filter = buildTransactionSearchFilter('phone', undefined, undefined, 'RequestedFunds');

		expect(filter).toEqual({
			OR: expect.arrayContaining([
				{
					agentName: {
						contains: 'phone',
						mode: 'insensitive',
					},
				},
			]),
		});
	});
});

describe('parseAmountSearchRange', () => {
	it('returns a full-ADA span for integer input', () => {
		expect(parseAmountSearchRange('1')).toEqual({ gte: 1000000n, lte: 1999999n });
		expect(parseAmountSearchRange('0')).toEqual({ gte: 0n, lte: 999999n });
	});

	it('returns a one-digit span for decimal input', () => {
		expect(parseAmountSearchRange('1.5')).toEqual({ gte: 1500000n, lte: 1599999n });
		expect(parseAmountSearchRange('1.50')).toEqual({ gte: 1500000n, lte: 1509999n });
	});

	it('matches exact amounts whose float representation rounds down', () => {
		// parseFloat('1.005') * 1e6 floors to 1004999, which produced an
		// inverted range under the old float math.
		expect(parseAmountSearchRange('1.005')).toEqual({ gte: 1005000n, lte: 1005999n });
		expect(parseAmountSearchRange('2.675')).toEqual({ gte: 2675000n, lte: 2675999n });
		expect(parseAmountSearchRange('8.165')).toEqual({ gte: 8165000n, lte: 8165999n });
	});

	it('returns an exact single-lovelace range for 6-decimal input', () => {
		expect(parseAmountSearchRange('1.000001')).toEqual({ gte: 1000001n, lte: 1000001n });
	});

	it('treats a trailing dot like an integer', () => {
		expect(parseAmountSearchRange('1.')).toEqual({ gte: 1000000n, lte: 1999999n });
	});

	it('returns an empty range for sub-lovelace precision', () => {
		const range = parseAmountSearchRange('1.0000005');
		expect(range).toBeDefined();
		expect(range!.gte > range!.lte).toBe(true);
	});

	it('ignores trailing zeros beyond lovelace precision', () => {
		expect(parseAmountSearchRange('1.0000010')).toEqual({ gte: 1000001n, lte: 1000001n });
	});

	it('preserves precision above 2^53 lovelace', () => {
		expect(parseAmountSearchRange('9007199254740993')).toEqual({
			gte: 9007199254740993000000n,
			lte: 9007199254740993999999n,
		});
	});

	it('rejects non-numeric input', () => {
		expect(parseAmountSearchRange('abc')).toBeUndefined();
		expect(parseAmountSearchRange('1e5')).toBeUndefined();
		expect(parseAmountSearchRange('-1')).toBeUndefined();
		expect(parseAmountSearchRange('1.2.3')).toBeUndefined();
		expect(parseAmountSearchRange('')).toBeUndefined();
	});
});
