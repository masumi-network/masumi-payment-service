import { OnChainState } from '@prisma/client';

export function buildTransactionHistoryInclude(includeHistory: boolean) {
	return {
		orderBy: { createdAt: 'desc' as const },
		take: includeHistory ? undefined : 0,
	};
}

export function parseAmountSearchRange(searchQuery: string): { gte: bigint; lte: bigint } | undefined {
	const numericMatch = searchQuery.match(/^(\d+\.?\d*)$/);
	if (!numericMatch) return undefined;

	const numericValue = parseFloat(numericMatch[1]);
	if (isNaN(numericValue) || numericValue < 0) return undefined;

	const hasDecimal = numericMatch[1].includes('.');
	let minLovelace: bigint;
	let maxLovelace: bigint;

	if (hasDecimal) {
		const decimalDigits = numericMatch[1].split('.')[1].length;
		const precision = Math.pow(10, decimalDigits);
		minLovelace = BigInt(Math.floor(numericValue * 1000000));
		const nextStep = (Math.floor(numericValue * precision) + 1) / precision;
		maxLovelace = BigInt(Math.floor(nextStep * 1000000)) - 1n;
	} else {
		minLovelace = BigInt(Math.floor(numericValue * 1000000));
		maxLovelace = BigInt(Math.floor((numericValue + 1) * 1000000)) - 1n;
	}

	return { gte: minLovelace, lte: maxLovelace };
}

export function buildMatchingStates(searchLower: string | undefined): OnChainState[] | undefined {
	if (!searchLower) return undefined;
	return Object.values(OnChainState).filter((s) => s.toLowerCase().includes(searchLower));
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
