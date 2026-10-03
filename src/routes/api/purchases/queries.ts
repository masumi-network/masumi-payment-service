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
import { queryPurchaseRequestSchemaInput } from './schemas';
import { PaymentSourceType } from '@/generated/prisma/client';

export type PurchaseListQueryInput = z.infer<typeof queryPurchaseRequestSchemaInput>;

/**
 * The filters the list and the count share. The count takes no cursor, limit or
 * history flag, so it supplies a subset of the list's input.
 */
export type PurchaseListWhereInput = Pick<
	PurchaseListQueryInput,
	| 'network'
	| 'filterSmartContractAddress'
	| 'filterPaymentSourceType'
	| 'filterOnChainState'
	| 'filterNeedsManualAction'
	| 'filterAgentIdentifier'
	| 'searchQuery'
>;

export function resolvePurchasePaymentSourceTypeFilter(input: {
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
 * The where clause behind both the purchase list and the purchase count.
 * Shared so the two can never disagree: they were hand-copied, and the count
 * silently ignored `filterOnChainState`.
 */
export function buildPurchaseListWhere(input: PurchaseListWhereInput, walletScopeIds: AuthContext['walletScopeIds']) {
	const searchLower = normalizeSearchQuery(input.searchQuery);
	return {
		PaymentSource: {
			deletedAt: null,
			network: input.network,
			smartContractAddress: input.filterSmartContractAddress ?? undefined,
			paymentSourceType: resolvePurchasePaymentSourceTypeFilter(input),
		},
		...buildWalletScopeFilter(walletScopeIds),
		...(input.filterOnChainState ? { onChainState: input.filterOnChainState } : {}),
		...buildNeedsManualActionFilter(input.filterNeedsManualAction),
		...buildAgentIdentifierFilter(input.filterAgentIdentifier),
		...buildTransactionSearchFilter(
			searchLower,
			buildMatchingStates(searchLower),
			searchLower ? parseAmountSearchRange(searchLower) : undefined,
			'PaidFunds',
		),
	};
}

export async function getPurchasesForQuery(
	input: PurchaseListQueryInput,
	walletScopeIds: AuthContext['walletScopeIds'],
) {
	return prisma.purchaseRequest.findMany({
		where: buildPurchaseListWhere(input, walletScopeIds),
		...cursorPaginationArgs(input.cursorId, input.limit),
		orderBy: { createdAt: 'desc' },
		include: {
			NextAction: {
				select: {
					id: true,
					requestedAction: true,
					errorType: true,
					errorNote: true,
				},
			},
			CurrentTransaction: {
				select: {
					id: true,
					createdAt: true,
					updatedAt: true,
					txHash: true,
					layer: true,
					hydraHeadId: true,
					status: true,
					fees: true,
					blockHeight: true,
					blockTime: true,
					previousOnChainState: true,
					newOnChainState: true,
					confirmations: true,
				},
			},
			PaidFunds: { select: { id: true, amount: true, unit: true } },
			PaymentSource: {
				select: {
					id: true,
					network: true,
					paymentSourceType: true,
					policyId: true,
					smartContractAddress: true,
				},
			},
			SellerWallet: { select: { id: true, walletVkey: true } },
			SmartContractWallet: {
				where: { deletedAt: null },
				select: { id: true, walletVkey: true, walletAddress: true },
			},
			WithdrawnForSeller: {
				select: { id: true, amount: true, unit: true },
			},
			WithdrawnForBuyer: { select: { id: true, amount: true, unit: true } },
			TransactionHistory:
				input.includeHistory == true
					? {
							orderBy: { createdAt: 'desc' },
							select: {
								id: true,
								createdAt: true,
								updatedAt: true,
								txHash: true,
								layer: true,
								hydraHeadId: true,
								status: true,
								fees: true,
								blockHeight: true,
								blockTime: true,
								previousOnChainState: true,
								newOnChainState: true,
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
								requestedAction: true,
								errorType: true,
								errorNote: true,
							},
						}
					: undefined,
		},
	});
}

export type PurchaseListRecord = Awaited<ReturnType<typeof getPurchasesForQuery>>[number];
