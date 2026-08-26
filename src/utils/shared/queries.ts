import { OnChainState, TransactionLayer } from '@prisma/client';

/** Largest value a Postgres `bigint` column can hold. */
const MAX_INT8 = 9223372036854775807n;

/**
 * Inclusive cursor pagination args for list endpoints. The cursor row is
 * intentionally returned again (no `skip: 1`) so retries and polling stay
 * idempotent — see docs/development.md#api-pagination before changing.
 */
export function cursorPaginationArgs(cursorId: string | null | undefined, take: number | undefined) {
	return {
		cursor: cursorId ? { id: cursorId } : undefined,
		take,
	};
}

/**
 * Parse a numeric search string into a lovelace range for amount filtering.
 * Mirrored by frontend/src/lib/parseAmountSearchRange.ts — keep in sync.
 *
 * Computed from the digit string directly — float math (parseFloat * 1e6)
 * produced inverted, empty ranges for values whose binary representation
 * rounds down (e.g. '1.005' gave gte 1004999n > lte 1004998n, so an exact
 * 1.005 ADA transaction never matched its own search).
 */
export function parseAmountSearchRange(searchQuery: string): { gte: bigint; lte: bigint } | undefined {
	const numericMatch = searchQuery.match(/^(\d+)(?:\.(\d*))?$/);
	if (!numericMatch) return undefined;

	const whole = numericMatch[1];
	const fraction = numericMatch[2] ?? '';

	// More fractional digits than lovelace can represent: a non-zero tail can
	// never match an integer lovelace amount. Keep the "matches nothing"
	// semantics (an explicitly empty range) rather than dropping the filter.
	if (fraction.length > 6 && /[1-9]/.test(fraction.slice(6))) {
		return { gte: 0n, lte: -1n };
	}

	const paddedFraction = fraction.slice(0, 6).padEnd(6, '0');
	const minLovelace = BigInt(whole + paddedFraction);
	// The search value is a prefix: '1.5' matches [1.5, 1.6) ADA, '1' matches
	// [1, 2) ADA — the span is one unit of the least-significant entered digit.
	const spanDigits = fraction.length === 0 ? 6 : Math.max(0, 6 - fraction.length);
	const span = 10n ** BigInt(spanDigits);
	const maxLovelace = minLovelace + span - 1n;

	// `amount` is a Postgres bigint. A bound past its range is rejected by the
	// driver, which turned a long numeric search (e.g. '99999999999999') into a
	// 500 instead of an empty result. Nothing can be stored above the ceiling,
	// so a range starting above it matches nothing, and one ending above it is
	// equivalent to one ending at the ceiling.
	if (minLovelace > MAX_INT8) return { gte: 0n, lte: -1n };

	return { gte: minLovelace, lte: maxLovelace > MAX_INT8 ? MAX_INT8 : maxLovelace };
}

export function buildMatchingStates(searchLower: string | undefined): OnChainState[] | undefined {
	if (!searchLower) return undefined;
	return Object.values(OnChainState).filter(
		(s) =>
			s.toLowerCase().includes(searchLower) ||
			s
				.replace(/([A-Z])/g, ' $1')
				.trim()
				.toLowerCase()
				.includes(searchLower),
	);
}

/**
 * Prisma where-fragment selecting payment/purchase requests that need an
 * operator to step in: the automated state machine parked them in
 * WaitingForManualAction (the only state error-state-recovery accepts), or a
 * NextAction error was recorded without changing the requested action.
 *
 * Shared between PaymentRequest and PurchaseRequest: both relate to their
 * action-data row via `NextAction`, and PaymentAction and PurchasingAction
 * both contain the literal 'WaitingForManualAction'.
 */
export function buildNeedsManualActionFilter(filterNeedsManualAction: boolean | undefined) {
	if (filterNeedsManualAction !== true) return {};
	return {
		NextAction: {
			OR: [{ requestedAction: 'WaitingForManualAction' as const }, { errorType: { not: null } }],
		},
	};
}

/**
 * Trim a raw search query and fold it to lower case, or return undefined when
 * nothing searchable is left. The frontend mirror trims before matching, so an
 * untrimmed backend disagreed with it: ' weather' matched client-side and
 * returned nothing server-side.
 *
 * Every column this query reaches is matched case-insensitively, so callers
 * need the lowercased form only — there is no case-preserving variant to keep
 * in step.
 */
export function normalizeSearchQuery(searchQuery: string | undefined): string | undefined {
	const trimmed = searchQuery?.trim();
	if (!trimmed) return undefined;
	return trimmed.toLowerCase();
}

/**
 * Escape the SQL LIKE metacharacters before a value is handed to Prisma's
 * `contains` / `startsWith`. Prisma interpolates the value straight into the
 * pattern, so an unescaped '%' matched every row on the server while the
 * frontend mirror compared it literally and matched none — the appear-on-
 * response flicker the mirror exists to prevent, inverted. Backslash is
 * Postgres' default LIKE escape character, so it has to be escaped first.
 */
export function escapeLikePattern(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * True when the query could plausibly be a hash or on-chain identifier, i.e.
 * hex and long enough to be selective.
 *
 * The hash columns and the two transaction-hash relations are only searched
 * when this holds. They cannot be served from an index, and the relation
 * branches compile to subqueries over the join table and the unindexed
 * `Transaction.txHash`, so running them for every short query made the
 * unbounded `count` endpoints scan far more than they had to. A hash is never
 * eight characters of prose, so nothing findable is lost.
 */
export function looksLikeHash(searchLower: string): boolean {
	return searchLower.length >= 8 && /^[0-9a-f]+$/.test(searchLower);
}

/**
 * Layers a query names, including the 'hydra' alias for L2. Matched exactly
 * rather than by substring: 'l1' contains '1', so a substring match would let
 * the single character '1' select every transaction on a layer.
 */
export function buildMatchingLayers(searchLower: string | undefined): TransactionLayer[] | undefined {
	if (!searchLower) return undefined;
	if (searchLower === 'hydra') return [TransactionLayer.L2];
	const matched = Object.values(TransactionLayer).filter((layer) => layer.toLowerCase() === searchLower);
	return matched.length > 0 ? matched : undefined;
}

/**
 * Restrict to an explicit set of agents. `undefined` means "no agent filter";
 * a value that is present but names no agent (e.g. '' or ',,') matches
 * nothing.
 *
 * Failing closed matters here: a caller building the parameter as
 * `agentIds.join(',')` sends '' for an empty selection, and returning "no
 * filter" for that showed every agent's transactions under one agent's
 * heading.
 *
 * Compared case-insensitively because agent identifiers are hex and
 * `validateHexString` accepts upper case, so a row can hold either form.
 */
export function buildAgentIdentifierFilter(filterAgentIdentifier: string | undefined) {
	if (filterAgentIdentifier === undefined) return {};
	const identifiers = filterAgentIdentifier
		.split(',')
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	if (identifiers.length === 0) return { agentIdentifier: { in: [] } };
	// Wrapped in AND so this OR cannot collide with the search filter's own OR
	// key when both fragments are spread into one where clause.
	return {
		AND: [
			{
				OR: identifiers.map((agentIdentifier) => ({
					agentIdentifier: { equals: agentIdentifier, mode: 'insensitive' as const },
				})),
			},
		],
	};
}

export function buildTransactionSearchFilter(
	searchLower: string | undefined,
	matchingStates: OnChainState[] | undefined,
	amountFilter: { gte: bigint; lte: bigint } | undefined,
	fundsRelation: 'RequestedFunds' | 'PaidFunds',
) {
	if (!searchLower) return {};
	const needle = escapeLikePattern(searchLower);
	const matchingLayers = buildMatchingLayers(searchLower);
	return {
		OR: [
			{
				agentIdentifier: {
					contains: needle,
					mode: 'insensitive' as const,
				},
			},
			{
				agentName: {
					contains: needle,
					mode: 'insensitive' as const,
				},
			},
			{ id: { contains: needle, mode: 'insensitive' as const } },
			// LZString-compressed then hex-encoded, so a substring carries no meaning:
			// consumers paste the whole value. Matched case-insensitively because a
			// purchase stores the identifier its buyer supplied, which need not be in
			// the lower-case form the generator emits.
			{ blockchainIdentifier: { equals: searchLower, mode: 'insensitive' as const } },
			// Hash columns and the transaction-hash relations only when the query
			// looks like a hash — see looksLikeHash for why.
			...(looksLikeHash(searchLower)
				? [
						{ inputHash: { contains: needle, mode: 'insensitive' as const } },
						{ resultHash: { contains: needle, mode: 'insensitive' as const } },
						{
							CurrentTransaction: {
								txHash: {
									contains: needle,
									mode: 'insensitive' as const,
								},
							},
						},
						// History holds the PREVIOUS transactions — a new attempt moves the old row
						// here — so the current hash lives only on CurrentTransaction. Both branches
						// are required to match any hash a transaction has ever had.
						{
							TransactionHistory: {
								some: {
									txHash: {
										contains: needle,
										mode: 'insensitive' as const,
									},
								},
							},
						},
					]
				: []),
			{
				SmartContractWallet: {
					walletAddress: {
						contains: needle,
						mode: 'insensitive' as const,
					},
				},
			},
			// A head id is hex like a hash, so it rides the same gate; the layer
			// branch is exact, so it only fires for 'l1', 'l2' and 'hydra'.
			...(looksLikeHash(searchLower)
				? [{ CurrentTransaction: { hydraHeadId: { contains: needle, mode: 'insensitive' as const } } }]
				: []),
			...(matchingLayers ? [{ CurrentTransaction: { layer: { in: matchingLayers } } }] : []),
			...(matchingStates && matchingStates.length > 0 ? [{ onChainState: { in: matchingStates } }] : []),
			...(amountFilter
				? [
						{
							[fundsRelation]: {
								some: {
									amount: {
										gte: amountFilter.gte,
										lte: amountFilter.lte,
									},
								},
							},
						},
					]
				: []),
		],
	};
}
