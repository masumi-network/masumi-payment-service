import { OnChainState } from '@prisma/client';

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

	return { gte: minLovelace, lte: maxLovelace };
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

export function normalizeSearchQuery(searchQuery: string | undefined): { raw: string; lower: string } | undefined {
	const raw = searchQuery?.trim();
	if (!raw) return undefined;
	return { raw, lower: raw.toLowerCase() };
}

export function buildAgentIdentifierFilter(filterAgentIdentifier: string | undefined) {
	if (!filterAgentIdentifier) return {};
	const identifiers = filterAgentIdentifier
		.split(',')
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
	// An all-empty list (e.g. ',,') must not become `in: ['']`, which matches nothing.
	if (identifiers.length === 0) return {};
	return { agentIdentifier: { in: identifiers } };
}

export function buildTransactionSearchFilter(
	searchLower: string | undefined,
	matchingStates: OnChainState[] | undefined,
	amountFilter: { gte: bigint; lte: bigint } | undefined,
	fundsRelation: 'RequestedFunds' | 'PaidFunds',
	searchRaw?: string,
) {
	if (!searchLower) return {};
	return {
		OR: [
			{
				agentIdentifier: {
					contains: searchLower,
					mode: 'insensitive' as const,
				},
			},
			{
				agentName: {
					contains: searchLower,
					mode: 'insensitive' as const,
				},
			},
			{ id: { contains: searchLower, mode: 'insensitive' as const } },
			// LZString-compressed then hex-encoded, so a substring carries no meaning
			// and `ILIKE '%..%'` could not use the unique index. Consumers paste the
			// whole value; exact match keeps this an index seek.
			{ blockchainIdentifier: { equals: searchRaw ?? searchLower } },
			{ inputHash: { contains: searchLower, mode: 'insensitive' as const } },
			{ resultHash: { contains: searchLower, mode: 'insensitive' as const } },
			{
				CurrentTransaction: {
					txHash: {
						contains: searchLower,
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
							contains: searchLower,
							mode: 'insensitive' as const,
						},
					},
				},
			},
			{
				SmartContractWallet: {
					walletAddress: {
						contains: searchLower,
						mode: 'insensitive' as const,
					},
				},
			},
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
