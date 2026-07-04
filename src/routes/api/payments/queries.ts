import { prisma } from '@masumi/payment-core/db';
import { z } from '@masumi/payment-core/zod';
import { AuthContext } from '@masumi/payment-core/auth';
import { parseAmountSearchRange, buildMatchingStates, buildTransactionSearchFilter } from '@/utils/shared/queries';
import { buildWalletScopeFilter } from '@/utils/shared/wallet-scope';
import { queryPaymentsSchemaInput } from './schemas';
import { PaymentSourceType } from '@/generated/prisma/client';

export type PaymentListQueryInput = z.infer<typeof queryPaymentsSchemaInput>;

export function resolvePaymentPaymentSourceTypeFilter(input: {
	filterPaymentSourceType?: PaymentSourceType;
	filterSmartContractAddress?: string | null;
}) {
	if (input.filterPaymentSourceType != null) return input.filterPaymentSourceType;
	if (input.filterSmartContractAddress != null) return undefined;
	return PaymentSourceType.Web3CardanoV1;
}

export async function getPaymentsForQuery(input: PaymentListQueryInput, walletScopeIds: AuthContext['walletScopeIds']) {
	const searchLower = input.searchQuery?.toLowerCase();
	const matchingStates = buildMatchingStates(searchLower);
	const amountFilter = searchLower ? parseAmountSearchRange(searchLower) : undefined;
	const paymentSourceTypeFilter = resolvePaymentPaymentSourceTypeFilter(input);

	return prisma.paymentRequest.findMany({
		where: {
			PaymentSource: {
				network: input.network,
				smartContractAddress: input.filterSmartContractAddress ?? undefined,
				paymentSourceType: paymentSourceTypeFilter,
				deletedAt: null,
			},
			...buildWalletScopeFilter(walletScopeIds),
			...(input.filterOnChainState ? { onChainState: input.filterOnChainState } : {}),
			...buildTransactionSearchFilter(searchLower, matchingStates, amountFilter, 'RequestedFunds'),
		},
		orderBy: { createdAt: 'desc' },
		cursor: input.cursorId
			? {
					id: input.cursorId,
				}
			: undefined,
		take: input.limit,
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
