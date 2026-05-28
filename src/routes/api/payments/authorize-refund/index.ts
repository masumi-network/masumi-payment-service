import { payAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { Network, OnChainState, PaymentAction, Prisma } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@masumi/payment-core/auth';
import { paymentResponseSchema } from '@/routes/api/payments';
import { decodeBlockchainIdentifier } from '@masumi/payment-core/blockchain-identifier';
import { lovelaceToAdaNumberSafe } from '@/utils/lovelace';
import { transformPaymentGetAmounts, transformPaymentGetTimestamps } from '@/utils/shared/transformers';
import { assertWalletInScope } from '@/utils/shared/wallet-scope';

export const authorizePaymentRefundSchemaInput = z.object({
	blockchainIdentifier: z.string().max(8000).describe('The identifier of the purchase to be refunded'),
	network: z.nativeEnum(Network).describe('The network the Cardano wallet will be used on'),
});

export const authorizePaymentRefundSchemaOutput = paymentResponseSchema.omit({
	TransactionHistory: true,
	ActionHistory: true,
});

export const authorizePaymentRefundEndpointPost = payAuthenticatedEndpointFactory.build({
	method: 'post',
	input: authorizePaymentRefundSchemaInput,
	output: authorizePaymentRefundSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof authorizePaymentRefundSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

		const payment = await prisma.paymentRequest.findUnique({
			where: {
				blockchainIdentifier: input.blockchainIdentifier,
				PaymentSource: {
					network: input.network,
					deletedAt: null,
				},
				NextAction: {
					requestedAction: {
						in: [PaymentAction.WaitingForExternalAction],
					},
				},
				onChainState: {
					in: [OnChainState.Disputed, OnChainState.RefundRequested],
				},
				SmartContractWallet: {
					deletedAt: null,
				},
				CurrentTransaction: {
					isNot: null,
				},
			},
		});

		if (payment == null) {
			throw createHttpError(404, 'Payment not found or in invalid state');
		}
		assertWalletInScope(ctx.walletScopeIds, payment.smartContractWalletId);

		if (payment.requestedById != ctx.id && !ctx.canAdmin) {
			throw createHttpError(403, 'You are not authorized to authorize a refund for this payment');
		}
		// Optimistic-lock guard via nextActionId — see submit-result/index.ts
		// for the full rationale.
		let result;
		try {
			result = await prisma.paymentRequest.update({
				where: { id: payment.id, nextActionId: payment.nextActionId },
				data: {
					ActionHistory: {
						connect: {
							id: payment.nextActionId,
						},
					},
					NextAction: {
						create: {
							requestedAction: PaymentAction.AuthorizeRefundRequested,
						},
					},
				},
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
				},
			});
		} catch (err) {
			if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
				throw createHttpError(409, 'Payment state changed concurrently; retry against the new state');
			}
			throw err;
		}
		if (result.inputHash == null) {
			throw createHttpError(500, 'Internal server error: Payment has no input hash');
		}

		const decoded = decodeBlockchainIdentifier(result.blockchainIdentifier);

		return {
			...result,
			...transformPaymentGetTimestamps(result),
			...transformPaymentGetAmounts(result),
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
