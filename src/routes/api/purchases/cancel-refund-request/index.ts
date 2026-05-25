import { z } from '@masumi/payment-core/zod';
import { Network, PaymentSourceType, PurchasingAction, OnChainState } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import { payAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@masumi/payment-core/auth';
import { purchaseResponseSchema } from '@/routes/api/purchases';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';
import { lovelaceToAdaNumberSafe } from '@/utils/lovelace';
import { transformPurchaseGetAmounts, transformPurchaseGetTimestamps } from '@/utils/shared/transformers';
import { assertWalletInScope } from '@/utils/shared/wallet-scope';

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
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

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
			include: {
				PaymentSource: {
					select: {
						paymentSourceType: true,
					},
				},
			},
		});
		if (purchase == null) {
			throw createHttpError(404, 'Purchase not found or in invalid state');
		}
		assertWalletInScope(ctx.walletScopeIds, purchase.smartContractWalletId);

		// Identity check must precede any state-shape 400 so an unauthorized
		// caller cannot infer the V2/state of a purchase by status-code timing.
		if (purchase.requestedById != ctx.id && !ctx.canAdmin) {
			throw createHttpError(403, 'You are not authorized to cancel a refund request for this purchase');
		}

		const requestedAction =
			purchase.PaymentSource.paymentSourceType === PaymentSourceType.Web3CardanoV2
				? PurchasingAction.AuthorizeWithdrawalRequested
				: PurchasingAction.UnSetRefundRequestedRequested;

		if (
			purchase.PaymentSource.paymentSourceType === PaymentSourceType.Web3CardanoV2 &&
			purchase.onChainState !== OnChainState.Disputed
		) {
			throw createHttpError(400, 'Authorize withdrawal is only available for disputed V2 purchases');
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
						requestedAction,
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
			},
		});

		const decoded = decodeBlockchainIdentifier(result.blockchainIdentifier);

		return {
			...result,
			...transformPurchaseGetTimestamps(result),
			...transformPurchaseGetAmounts(result),
			// safe: response schema is z.number() (ADA). lovelaceToAdaNumberSafe
			// throws if the lovelace value exceeds Number.MAX_SAFE_INTEGER.
			totalBuyerCardanoFees: lovelaceToAdaNumberSafe(result.totalBuyerCardanoFees),
			totalSellerCardanoFees: lovelaceToAdaNumberSafe(result.totalSellerCardanoFees),
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
