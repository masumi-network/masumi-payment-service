import { prisma } from '@masumi/payment-core/db';
import { z } from '@masumi/payment-core/zod';
import { AuthContext } from '@masumi/payment-core/auth';
import {
	cursorPaginationArgs,
	parseAmountSearchRange,
	buildMatchingStates,
	buildNeedsManualActionFilter,
	buildTransactionSearchFilter,
	buildAgentIdentifierFilter,
	normalizeSearchQuery,
} from '@/utils/shared/queries';
import { buildWalletScopeFilter } from '@/utils/shared/wallet-scope';
import { queryPaymentsSchemaInput } from './schemas';
import { PaymentSourceType } from '@/generated/prisma/client';

export type PaymentListQueryInput = z.infer<typeof queryPaymentsSchemaInput>;

/**
 * The filters the list and the count share. The count takes no cursor, limit or
 * history flag, so it supplies a subset of the list's input.
 */
export type PaymentListWhereInput = Pick<
	PaymentListQueryInput,
	| 'network'
	| 'filterSmartContractAddress'
	| 'filterPaymentSourceType'
	| 'filterOnChainState'
	| 'filterNeedsManualAction'
	| 'filterAgentIdentifier'
	| 'searchQuery'
>;

export function resolvePaymentPaymentSourceTypeFilter(input: {
	filterPaymentSourceType?: PaymentSourceType;
	filterSmartContractAddress?: string | null;
	filterAgentIdentifier?: string;
}) {
	if (input.filterPaymentSourceType != null) return input.filterPaymentSourceType;
	if (input.filterSmartContractAddress != null) return undefined;
	// An exact agent lookup names one agent, which may well live on a V2 source.
	// Applying the V1 compatibility default here returned nothing for those
	// agents. Mirrors resolveRegistryPaymentSourceTypeFilter.
	if (input.filterAgentIdentifier != null) return undefined;
	return PaymentSourceType.Web3CardanoV1;
}

/**
 * The where clause behind both the payment list and the payment count. Shared
 * so the two can never disagree: they were hand-copied, and the count silently
 * ignored `filterOnChainState`, so a state-filtered page reported a total for
 * every state.
 */
export function buildPaymentListWhere(input: PaymentListWhereInput, walletScopeIds: AuthContext['walletScopeIds']) {
	const searchLower = normalizeSearchQuery(input.searchQuery);
	return {
		PaymentSource: {
			network: input.network,
			smartContractAddress: input.filterSmartContractAddress ?? undefined,
			paymentSourceType: resolvePaymentPaymentSourceTypeFilter(input),
			deletedAt: null,
		},
		...buildWalletScopeFilter(walletScopeIds),
		...(input.filterOnChainState ? { onChainState: input.filterOnChainState } : {}),
		...buildNeedsManualActionFilter(input.filterNeedsManualAction),
		...buildAgentIdentifierFilter(input.filterAgentIdentifier),
		...buildTransactionSearchFilter(
			searchLower,
			buildMatchingStates(searchLower),
			searchLower ? parseAmountSearchRange(searchLower) : undefined,
			'RequestedFunds',
		),
	};
}

export async function getPaymentsForQuery(input: PaymentListQueryInput, walletScopeIds: AuthContext['walletScopeIds']) {
	return prisma.paymentRequest.findMany({
		where: buildPaymentListWhere(input, walletScopeIds),
		orderBy: { createdAt: 'desc' },
		...cursorPaginationArgs(input.cursorId, input.limit),
		include: {
			BuyerWallet: { select: { id: true, walletVkey: true } },
			SmartContractWallet: {
				where: { deletedAt: null },
				select: { id: true, walletVkey: true, walletAddress: true },
			},
			RequestedFunds: { select: { id: true, amount: true, unit: true } },
			NextAction: {
				select: {
					id: true,
					requestedAction: true,
					errorType: true,
					errorNote: true,
					resultHash: true,
				},
			},
			PaymentSource: {
				select: {
					id: true,
					network: true,
					paymentSourceType: true,
					smartContractAddress: true,
					policyId: true,
				},
			},
			CurrentTransaction: {
				select: {
					id: true,
					createdAt: true,
					updatedAt: true,
					fees: true,
					blockHeight: true,
					blockTime: true,
					txHash: true,
					layer: true,
					hydraHeadId: true,
					status: true,
					previousOnChainState: true,
					newOnChainState: true,
					confirmations: true,
				},
			},
			WithdrawnForSeller: {
				select: { id: true, amount: true, unit: true },
			},
			WithdrawnForBuyer: {
				select: { id: true, amount: true, unit: true },
			},
			TransactionHistory:
				input.includeHistory == true
					? {
							orderBy: { createdAt: 'desc' },
							select: {
								id: true,
								createdAt: true,
								updatedAt: true,
								txHash: true,
								status: true,
								fees: true,
								blockHeight: true,
								blockTime: true,
								previousOnChainState: true,
								newOnChainState: true,
								layer: true,
								hydraHeadId: true,
								confirmations: true,
							},
						}
					: undefined,
			ActionHistory:
				input.includeHistory == true
					? {
							orderBy: { createdAt: 'desc' },
							select: {
								id: true,
								createdAt: true,
								updatedAt: true,
								submittedTxHash: true,
								requestedAction: true,
								errorType: true,
								errorNote: true,
								resultHash: true,
							},
						}
					: undefined,
		},
	});
}

export type PaymentListRecord = Awaited<ReturnType<typeof getPaymentsForQuery>>[number];
