import { payAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { Network, OnChainState, PaymentAction } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@masumi/payment-core/auth';
import { paymentResponseSchema } from '@/routes/api/payments';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';
import { lovelaceToAdaNumberSafe } from '@/utils/lovelace';
import { transformPaymentGetAmounts, transformPaymentGetTimestamps } from '@/utils/shared/transformers';
import { assertWalletInScope } from '@/utils/shared/wallet-scope';

export const submitPaymentResultSchemaInput = z.object({
	network: z.nativeEnum(Network).describe('The network the payment was received on'),
	submitResultHash: z
		.string()
		.max(250)
		.describe(
			'The hash of the AI agent result to be submitted, should be sha256 hash of the result, therefore needs to be in hex string format',
		),
	blockchainIdentifier: z.string().max(8000).describe('The identifier of the payment'),
});

export const submitPaymentResultSchemaOutput = paymentResponseSchema.omit({
	TransactionHistory: true,
	ActionHistory: true,
});

export const submitPaymentResultEndpointPost = payAuthenticatedEndpointFactory.build({
	method: 'post',
	input: submitPaymentResultSchemaInput,
	output: submitPaymentResultSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof submitPaymentResultSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

		const payment = await prisma.paymentRequest.findUnique({
			where: {
				onChainState: {
					in: [OnChainState.RefundRequested, OnChainState.Disputed, OnChainState.FundsLocked],
				},
				blockchainIdentifier: input.blockchainIdentifier,
				NextAction: {
					requestedAction: {
						in: [PaymentAction.WaitingForExternalAction],
					},
				},
				PaymentSource: {
					network: input.network,
					deletedAt: null,
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
			throw createHttpError(403, 'You are not authorized to submit results for this payment');
		}

		const result = await prisma.paymentRequest.update({
			where: { id: payment.id },
			data: {
				ActionHistory: {
					connect: {
						id: payment.nextActionId,
					},
				},
				NextAction: {
					create: {
						requestedAction: PaymentAction.SubmitResultRequested,
						resultHash: input.submitResultHash,
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
