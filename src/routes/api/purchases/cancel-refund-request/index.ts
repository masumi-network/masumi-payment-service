import { z } from '@/utils/zod-openapi';
import { Network, PurchasingAction, OnChainState, Permission } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { purchaseResponseSchema } from '@/routes/api/purchases';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';
import { transformPurchaseGetAmounts, transformPurchaseGetTimestamps } from '@/utils/shared/transformers';

export const cancelPurchaseRefundRequestSchemaInput = z.object({
	blockchainIdentifier: z.string().max(8000).describe('The identifier of the purchase to be refunded'),
	network: z.nativeEnum(Network).describe('The network the Cardano wallet will be used on'),
});

export const cancelPurchaseRefundRequestSchemaOutput = purchaseResponseSchema.omit({
	TransactionHistory: true,
	ActionHistory: true,
});

export const cancelPurchaseRefundRequestPost = payAuthenticatedEndpointFactory.build({
	method: 'post',
	input: cancelPurchaseRefundRequestSchemaInput,
	output: cancelPurchaseRefundRequestSchemaOutput,
	handler: async ({
		input,
		ctx,
	}: {
		input: z.infer<typeof cancelPurchaseRefundRequestSchemaInput>;
		ctx: AuthContext;
	}) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network, ctx.permission);

		const purchase = await prisma.purchaseRequest.findUnique({
			where: {
				blockchainIdentifier: input.blockchainIdentifier,
				NextAction: {
					requestedAction: {
						in: [PurchasingAction.WaitingForExternalAction],
					},
				},
				onChainState: {
					in: [OnChainState.RefundRequested, OnChainState.Disputed],
				},
				PaymentSource: {
					network: input.network,
					deletedAt: null,
				},
				SmartContractWallet: {
					deletedAt: null,
				},
				CurrentTransaction: {
					txHash: { not: null },
				},
			},
		});
		if (purchase == null) {
			throw createHttpError(404, 'Purchase not found or in invalid state');
		}

		if (purchase.requestedById != ctx.id && ctx.permission != Permission.Admin) {
			throw createHttpError(403, 'You are not authorized to cancel a refund request for this purchase');
		}

		const result = await prisma.purchaseRequest.update({
			where: { id: purchase.id },
			data: {
				ActionHistory: {
					connect: {
						id: purchase.nextActionId,
					},
				},
				NextAction: {
					create: {
						requestedAction: PurchasingAction.UnSetRefundRequestedRequested,
					},
				},
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
			},
		});

		const decoded = decodeBlockchainIdentifier(result.blockchainIdentifier);

		return {
			...result,
			...transformPurchaseGetTimestamps(result),
			...transformPurchaseGetAmounts(result),
			totalBuyerCardanoFees: Number(result.totalBuyerCardanoFees.toString()) / 1_000_000,
			totalSellerCardanoFees: Number(result.totalSellerCardanoFees.toString()) / 1_000_000,
			agentIdentifier: decoded?.agentIdentifier ?? null,
			CurrentTransaction: result.CurrentTransaction
				? {
						...result.CurrentTransaction,
						fees: result.CurrentTransaction.fees?.toString() ?? null,
					}
				: null,
		};
	},
});
