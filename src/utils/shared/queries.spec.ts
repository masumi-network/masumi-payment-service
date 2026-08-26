import {
	buildAgentIdentifierFilter,
	buildMatchingLayers,
	buildNeedsManualActionFilter,
	buildTransactionSearchFilter,
	escapeLikePattern,
	looksLikeHash,
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
		expect(normalizeSearchQuery(' weather ')).toBe('weather');
		expect(normalizeSearchQuery('\tWeather\n')).toBe('weather');
	});

	it('keeps a trimmed numeric query parseable as an amount', () => {
		expect(parseAmountSearchRange(normalizeSearchQuery('  1.5 ')!)).toEqual({ gte: 1500000n, lte: 1599999n });
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
	const agentClauses = (filter: string | undefined) =>
		(buildAgentIdentifierFilter(filter) as { AND?: [{ OR: unknown[] }] }).AND?.[0].OR;

	it('returns an empty fragment when no filter is supplied', () => {
		expect(buildAgentIdentifierFilter(undefined)).toEqual({});
	});

	it('matches a single identifier exactly, ignoring case', () => {
		// Identifiers are hex and validateHexString accepts upper case, so a row can
		// hold either form and an exact case-sensitive compare would miss it.
		expect(agentClauses('abc123')).toEqual([{ agentIdentifier: { equals: 'abc123', mode: 'insensitive' } }]);
		expect(agentClauses('AbC123')).toEqual([{ agentIdentifier: { equals: 'AbC123', mode: 'insensitive' } }]);
	});

	it('splits a comma-separated list and trims each entry', () => {
		expect(agentClauses(' abc123 , def456 ')).toEqual([
			{ agentIdentifier: { equals: 'abc123', mode: 'insensitive' } },
			{ agentIdentifier: { equals: 'def456', mode: 'insensitive' } },
		]);
	});

	it('drops empty entries from a list that still names an agent', () => {
		expect(agentClauses('abc123,,def456')).toEqual([
			{ agentIdentifier: { equals: 'abc123', mode: 'insensitive' } },
			{ agentIdentifier: { equals: 'def456', mode: 'insensitive' } },
		]);
	});

	it('matches nothing when the filter is present but names no agent', () => {
		// Fails closed: a caller building the parameter as `agentIds.join(',')`
		// sends '' for an empty selection, and returning "no filter" for that
		// showed every agent's transactions under one agent's heading.
		expect(buildAgentIdentifierFilter('')).toEqual({ agentIdentifier: { in: [] } });
		expect(buildAgentIdentifierFilter(',,')).toEqual({ agentIdentifier: { in: [] } });
		expect(buildAgentIdentifierFilter('   ')).toEqual({ agentIdentifier: { in: [] } });
	});

	it('nests its OR under AND so it cannot clobber the search filter OR', () => {
		const where = {
			...buildAgentIdentifierFilter('abc123'),
			...buildTransactionSearchFilter('weather', undefined, undefined, 'RequestedFunds'),
		} as { AND?: unknown[]; OR?: unknown[] };

		expect(where.AND).toBeDefined();
		expect(where.OR).toBeDefined();
	});
});

describe('escapeLikePattern', () => {
	it('neutralises the LIKE metacharacters', () => {
		// Prisma interpolates the value straight into the pattern, so an unescaped
		// '%' matched every row while the frontend mirror matched none.
		expect(escapeLikePattern('100%')).toBe('100\\%');
		expect(escapeLikePattern('a_b')).toBe('a\\_b');
		expect(escapeLikePattern('a\\b')).toBe('a\\\\b');
	});

	it('leaves an ordinary query untouched', () => {
		expect(escapeLikePattern('weather')).toBe('weather');
	});
});

describe('looksLikeHash', () => {
	it('accepts hex of at least eight characters', () => {
		expect(looksLikeHash('deadbeef')).toBe(true);
		expect(looksLikeHash('0123456789abcdef')).toBe(true);
	});

	it('rejects short or non-hex queries', () => {
		expect(looksLikeHash('abc')).toBe(false);
		expect(looksLikeHash('deadbee')).toBe(false);
		expect(looksLikeHash('weatheragent')).toBe(false);
	});
});

describe('buildMatchingLayers', () => {
	it('matches a layer name exactly and maps the hydra alias to L2', () => {
		expect(buildMatchingLayers('l1')).toEqual(['L1']);
		expect(buildMatchingLayers('l2')).toEqual(['L2']);
		expect(buildMatchingLayers('hydra')).toEqual(['L2']);
	});

	it('does not match on a substring', () => {
		// 'l1' contains '1', so a substring match would let a single character
		// select every transaction on a layer.
		expect(buildMatchingLayers('1')).toBeUndefined();
		expect(buildMatchingLayers('l')).toBeUndefined();
		expect(buildMatchingLayers(undefined)).toBeUndefined();
	});
});

describe('buildTransactionSearchFilter', () => {
	const orClauses = (searchLower: string) =>
		(
			buildTransactionSearchFilter(searchLower, undefined, undefined, 'RequestedFunds') as {
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

	it('includes agentIdentifier, id and wallet address for any query', () => {
		const clauses = orClauses('abc');

		expect(clauses).toContainEqual({ agentIdentifier: { contains: 'abc', mode: 'insensitive' } });
		expect(clauses).toContainEqual({ id: { contains: 'abc', mode: 'insensitive' } });
		expect(clauses).toContainEqual({
			SmartContractWallet: { walletAddress: { contains: 'abc', mode: 'insensitive' } },
		});
	});

	it('escapes LIKE metacharacters in every contains clause', () => {
		// Unescaped, '%' matched every row server-side while the frontend mirror
		// compared it literally and matched none.
		const clauses = orClauses('100%') as Array<Record<string, { contains?: string }>>;
		expect(clauses).toContainEqual({ agentName: { contains: '100\\%', mode: 'insensitive' } });
		for (const clause of clauses) {
			for (const value of Object.values(clause)) {
				if (value?.contains !== undefined) expect(value.contains).toBe('100\\%');
			}
		}

		// `equals` is not a LIKE pattern, so escaping it would search for a
		// literal backslash that is not in the stored value.
		expect(clauses).toContainEqual({ blockchainIdentifier: { equals: '100%', mode: 'insensitive' } });
	});

	it('searches the hash columns and relations only for a hash-shaped query', () => {
		// History holds the PREVIOUS transactions, so the current hash is only ever on
		// CurrentTransaction — dropping either branch loses half the hashes.
		const hashClauses = orClauses('deadbeef');

		expect(hashClauses).toContainEqual({ inputHash: { contains: 'deadbeef', mode: 'insensitive' } });
		expect(hashClauses).toContainEqual({ resultHash: { contains: 'deadbeef', mode: 'insensitive' } });
		expect(hashClauses).toContainEqual({
			CurrentTransaction: { txHash: { contains: 'deadbeef', mode: 'insensitive' } },
		});
		expect(hashClauses).toContainEqual({
			TransactionHistory: { some: { txHash: { contains: 'deadbeef', mode: 'insensitive' } } },
		});
		expect(hashClauses).toContainEqual({
			CurrentTransaction: { hydraHeadId: { contains: 'deadbeef', mode: 'insensitive' } },
		});
	});

	it('omits the hash branches for a short or non-hex query', () => {
		// These cannot be answered from an index and the relation branches compile
		// to subqueries, so running them for every keystroke made the unbounded
		// count endpoints scan far more than they had to.
		const clauses = JSON.stringify(orClauses('weather'));

		expect(clauses).not.toContain('inputHash');
		expect(clauses).not.toContain('resultHash');
		expect(clauses).not.toContain('txHash');
		expect(clauses).not.toContain('TransactionHistory');
		expect(clauses).not.toContain('hydraHeadId');
	});

	it('matches blockchainIdentifier exactly and case-insensitively', () => {
		// Compressed-then-hex encoded, so a substring is meaningless: consumers paste
		// the whole value. A purchase stores the identifier its buyer supplied, which
		// need not be in the lower-case form the generator emits.
		expect(orClauses('abcdef')).toContainEqual({
			blockchainIdentifier: { equals: 'abcdef', mode: 'insensitive' },
		});
	});

	it('adds a layer branch only for a layer name', () => {
		expect(orClauses('hydra')).toContainEqual({ CurrentTransaction: { layer: { in: ['L2'] } } });
		expect(JSON.stringify(orClauses('weather'))).not.toContain('layer');
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
		// 2^53 + 1 lovelace: exactly the value a float round-trip would lose.
		expect(parseAmountSearchRange('9007199254.740993')).toEqual({
			gte: 9007199254740993n,
			lte: 9007199254740993n,
		});
	});

	it('clamps a range that would overflow the bigint amount column', () => {
		// `amount` is a Postgres bigint, and a bound past its range is rejected by
		// the driver — a long numeric query used to 500 instead of returning
		// nothing. Nothing can be stored above the ceiling, so a range starting
		// above it matches nothing.
		const overflowing = parseAmountSearchRange('99999999999999');
		expect(overflowing).toBeDefined();
		expect(overflowing!.gte > overflowing!.lte).toBe(true);

		// A range that merely ends above the ceiling is capped at it.
		expect(parseAmountSearchRange('9223372036854')).toEqual({
			gte: 9223372036854000000n,
			lte: 9223372036854775807n,
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
