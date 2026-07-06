// Import from the generated enums module (not '@prisma/client'): the bare
// specifier only resolves through the tsconfig paths alias, which Jest does
// not replicate — enums.ts loads fine in every environment.
import { OnChainState } from '@/generated/prisma/enums';

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
