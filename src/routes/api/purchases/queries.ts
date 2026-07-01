import { prisma } from '@masumi/payment-core/db';
import { z } from '@masumi/payment-core/zod';
import { AuthContext } from '@masumi/payment-core/auth';
import { parseAmountSearchRange, buildMatchingStates, buildTransactionSearchFilter } from '@/utils/shared/queries';
import { buildWalletScopeFilter } from '@/utils/shared/wallet-scope';
import { queryPurchaseRequestSchemaInput } from './schemas';

export type PurchaseListQueryInput = z.infer<typeof queryPurchaseRequestSchemaInput>;

export async function getPurchasesForQuery(
	input: PurchaseListQueryInput,
	walletScopeIds: AuthContext['walletScopeIds'],
) {
	const searchLower = input.searchQuery?.toLowerCase();
	const matchingStates = buildMatchingStates(searchLower);
	const amountFilter = searchLower ? parseAmountSearchRange(searchLower) : undefined;

	return prisma.purchaseRequest.findMany({
		where: {
			PaymentSource: {
				deletedAt: null,
				network: input.network,
				smartContractAddress: input.filterSmartContractAddress ?? undefined,
				paymentSourceType: input.filterPaymentSourceType,
			},
			...buildWalletScopeFilter(walletScopeIds),
			...(input.filterOnChainState ? { onChainState: input.filterOnChainState } : {}),
			...buildTransactionSearchFilter(searchLower, matchingStates, amountFilter, 'PaidFunds'),
		},
		cursor: input.cursorId ? { id: input.cursorId } : undefined,
		take: input.limit,
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
