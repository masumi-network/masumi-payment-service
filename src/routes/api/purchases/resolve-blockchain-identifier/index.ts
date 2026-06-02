import { z } from '@masumi/payment-core/zod';
import { Network } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@masumi/payment-core/auth';
import { readAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { transformPurchaseGetTimestamps, transformPurchaseGetAmounts } from '@/utils/shared/transformers';
import { decodeBlockchainIdentifier } from '@masumi/payment-core/blockchain-identifier';
import { lovelaceToAdaNumberSafe } from '@/utils/lovelace';
import { purchaseResponseSchema } from '@/routes/api/purchases';
import { buildWalletScopeFilter } from '@/utils/shared/wallet-scope';

export const postPurchaseRequestSchemaInput = z.object({
	blockchainIdentifier: z.string().min(1).max(8000).describe('The blockchain identifier to resolve'),
	network: z.nativeEnum(Network).describe('The network the purchases were made on'),
	filterSmartContractAddress: z
		.string()
		.optional()
		.nullable()
		.describe('The smart contract address of the payment source'),
	includeHistory: z
		.string()
		.default('false')
		.optional()
		.transform((val) => val?.toLowerCase() == 'true')
		.describe('Whether to include the full transaction and status history of the purchases'),
});

export const postPurchaseRequestSchemaOutput = purchaseResponseSchema;

export const resolvePurchaseRequestPost = readAuthenticatedEndpointFactory.build({
	method: 'post',
	input: postPurchaseRequestSchemaInput,
	output: postPurchaseRequestSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof postPurchaseRequestSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

		const purchase = await prisma.purchaseRequest.findFirst({
			where: {
				PaymentSource: {
					deletedAt: null,
					network: input.network,
					smartContractAddress: input.filterSmartContractAddress ?? undefined,
				},
				blockchainIdentifier: input.blockchainIdentifier,
				...buildWalletScopeFilter(ctx.walletScopeIds),
			},
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
		if (purchase == null) {
			throw createHttpError(404, 'Purchase not found');
		}

		return {
			...purchase,
			...transformPurchaseGetTimestamps(purchase),
			...transformPurchaseGetAmounts(purchase),
			// safe: response schema is z.number() (ADA). lovelaceToAdaNumberSafe
			// throws if the lovelace value exceeds Number.MAX_SAFE_INTEGER.
			totalBuyerCardanoFees: lovelaceToAdaNumberSafe(purchase.totalBuyerCardanoFees),
			totalSellerCardanoFees: lovelaceToAdaNumberSafe(purchase.totalSellerCardanoFees),
			agentIdentifier: decodeBlockchainIdentifier(purchase.blockchainIdentifier)?.agentIdentifier ?? null,
			CurrentTransaction: purchase.CurrentTransaction
				? {
						...purchase.CurrentTransaction,
						fees: purchase.CurrentTransaction.fees?.toString() ?? null,
					}
				: null,
			TransactionHistory:
				input.includeHistory == true
					? purchase.TransactionHistory.map((tx) => ({
							...tx,
							fees: tx.fees?.toString() ?? null,
						}))
					: null,
			ActionHistory: purchase.ActionHistory
				? purchase.ActionHistory.map((action) => ({
						id: action.id,
						createdAt: action.createdAt,
						updatedAt: action.updatedAt,
						requestedAction: action.requestedAction,
						errorType: action.errorType,
						errorNote: action.errorNote,
					}))
				: null,
		};
	},
});
