import { OnChainState } from '@prisma/client';

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

export function buildTransactionSearchFilter(
	searchLower: string | undefined,
	matchingStates: OnChainState[] | undefined,
	amountFilter: { gte: bigint; lte: bigint } | undefined,
	fundsRelation: 'RequestedFunds' | 'PaidFunds',
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
			{
				CurrentTransaction: {
					txHash: {
						contains: searchLower,
						mode: 'insensitive' as const,
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
