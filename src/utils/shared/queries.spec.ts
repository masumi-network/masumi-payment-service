import {
	buildAgentIdentifierFilter,
	buildNeedsManualActionFilter,
	buildTransactionSearchFilter,
	normalizeSearchQuery,
	parseAmountSearchRange,
} from './queries';

describe('normalizeSearchQuery', () => {
	it('returns undefined for blank input', () => {
		expect(normalizeSearchQuery(undefined)).toBeUndefined();
		expect(normalizeSearchQuery('')).toBeUndefined();
		expect(normalizeSearchQuery('   ')).toBeUndefined();
	});

	it('trims surrounding whitespace and lowercases', () => {
		// The frontend mirror trims; an untrimmed backend disagreed with it, so
		// ' weather' matched client-side and returned nothing server-side.
		expect(normalizeSearchQuery(' weather ')).toEqual({ raw: 'weather', lower: 'weather' });
		expect(normalizeSearchQuery('\tWeather\n')).toEqual({ raw: 'Weather', lower: 'weather' });
	});

	it('preserves case in raw for the exact blockchainIdentifier match', () => {
		expect(normalizeSearchQuery(' AbCdEf ')).toEqual({ raw: 'AbCdEf', lower: 'abcdef' });
	});

	it('keeps a trimmed numeric query parseable as an amount', () => {
		const search = normalizeSearchQuery('  1.5 ');
		expect(parseAmountSearchRange(search!.lower)).toEqual({ gte: 1500000n, lte: 1599999n });
	});
});

describe('buildNeedsManualActionFilter', () => {
	it('returns an empty fragment when the filter is off', () => {
		expect(buildNeedsManualActionFilter(undefined)).toEqual({});
		expect(buildNeedsManualActionFilter(false)).toEqual({});
	});

	it('matches WaitingForManualAction or a recorded error on the next action', () => {
		expect(buildNeedsManualActionFilter(true)).toEqual({
			NextAction: {
				OR: [{ requestedAction: 'WaitingForManualAction' }, { errorType: { not: null } }],
			},
		});
	});
});

describe('buildAgentIdentifierFilter', () => {
	it('returns an empty fragment when no filter is supplied', () => {
		expect(buildAgentIdentifierFilter(undefined)).toEqual({});
		expect(buildAgentIdentifierFilter('')).toEqual({});
	});

	it('matches a single identifier exactly', () => {
		expect(buildAgentIdentifierFilter('abc123')).toEqual({
			agentIdentifier: { in: ['abc123'] },
		});
	});

	it('splits a comma-separated list and trims each entry', () => {
		expect(buildAgentIdentifierFilter(' abc123 , def456 ')).toEqual({
			agentIdentifier: { in: ['abc123', 'def456'] },
		});
	});

	it('drops empty entries rather than emitting an unmatchable in: []', () => {
		expect(buildAgentIdentifierFilter('abc123,,def456')).toEqual({
			agentIdentifier: { in: ['abc123', 'def456'] },
		});
		// All-empty must fall back to "no filter", never `in: ['']`, which silently
		// matches nothing and would return an empty list instead of every row.
		expect(buildAgentIdentifierFilter(',,')).toEqual({});
		expect(buildAgentIdentifierFilter('   ')).toEqual({});
	});

	it('preserves identifier case', () => {
		// Identifiers are hex asset ids compared exactly; lowercasing here would
		// stop mixed-case input from ever matching the stored value.
		expect(buildAgentIdentifierFilter('AbC123')).toEqual({
			agentIdentifier: { in: ['AbC123'] },
		});
	});
});

describe('buildTransactionSearchFilter', () => {
	const orClauses = (searchLower: string, searchRaw?: string) =>
		(
			buildTransactionSearchFilter(searchLower, undefined, undefined, 'RequestedFunds', searchRaw) as {
				OR: unknown[];
			}
		).OR;

	it('returns an empty fragment without a query', () => {
		expect(buildTransactionSearchFilter(undefined, undefined, undefined, 'RequestedFunds')).toEqual({});
	});

	it('includes agentName in search OR clauses', () => {
		expect(orClauses('phone')).toContainEqual({
			agentName: { contains: 'phone', mode: 'insensitive' },
		});
	});

	it('includes agentIdentifier, id, hashes and wallet address', () => {
		const clauses = orClauses('abc');

		expect(clauses).toContainEqual({ agentIdentifier: { contains: 'abc', mode: 'insensitive' } });
		expect(clauses).toContainEqual({ id: { contains: 'abc', mode: 'insensitive' } });
		expect(clauses).toContainEqual({ inputHash: { contains: 'abc', mode: 'insensitive' } });
		expect(clauses).toContainEqual({ resultHash: { contains: 'abc', mode: 'insensitive' } });
		expect(clauses).toContainEqual({
			SmartContractWallet: { walletAddress: { contains: 'abc', mode: 'insensitive' } },
		});
	});

	it('matches both the current and historical transaction hashes', () => {
		// History holds the PREVIOUS transactions, so the current hash is only ever on
		// CurrentTransaction — dropping either branch loses half the hashes.
		const clauses = orClauses('deadbeef');

		expect(clauses).toContainEqual({
			CurrentTransaction: { txHash: { contains: 'deadbeef', mode: 'insensitive' } },
		});
		expect(clauses).toContainEqual({
			TransactionHistory: { some: { txHash: { contains: 'deadbeef', mode: 'insensitive' } } },
		});
	});

	it('matches blockchainIdentifier exactly, on the raw query', () => {
		// Compressed-then-hex encoded: a substring is meaningless and `contains` would
		// also forfeit the unique index. The raw value must survive lowercasing.
		expect(orClauses('abcdef', 'AbCdEf')).toContainEqual({
			blockchainIdentifier: { equals: 'AbCdEf' },
		});
	});

	it('falls back to the lowercased query when no raw query is passed', () => {
		expect(orClauses('abcdef')).toContainEqual({ blockchainIdentifier: { equals: 'abcdef' } });
	});

	it('never matches on network or payment source type', () => {
		// Both are already fixed by the surrounding where clause, so an OR branch on
		// either would match every row and turn any substring into "return everything".
		expect(JSON.stringify(orClauses('preprod'))).not.toContain('network');
		expect(JSON.stringify(orClauses('web3cardanov1'))).not.toContain('paymentSourceType');
	});

	it('adds state and amount branches only when they resolve', () => {
		expect(orClauses('abc')).not.toContainEqual(expect.objectContaining({ onChainState: expect.anything() }));

		const withExtras = buildTransactionSearchFilter(
			'1',
			['FundsLocked'],
			{ gte: 1000000n, lte: 1999999n },
			'PaidFunds',
		) as { OR: unknown[] };

		expect(withExtras.OR).toContainEqual({ onChainState: { in: ['FundsLocked'] } });
		expect(withExtras.OR).toContainEqual({
			PaidFunds: { some: { amount: { gte: 1000000n, lte: 1999999n } } },
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
