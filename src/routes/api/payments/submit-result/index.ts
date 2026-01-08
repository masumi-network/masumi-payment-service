import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import { z } from '@/utils/zod-openapi';
import {
  $Enums,
  Network,
  OnChainState,
  PaymentAction,
  Permission,
} from '@prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { modifyPaymentNextAction } from '@/utils/action-history';
import { paymentResponseSchema } from '@/routes/api/payments';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';
import {
  transformPaymentGetAmounts,
  transformPaymentGetTimestamps,
} from '@/utils/shared/transformers';

export const submitPaymentResultSchemaInput = z.object({
  network: z
    .nativeEnum(Network)
    .describe('The network the payment was received on'),
  submitResultHash: z
    .string()
    .max(250)
    .describe(
      'The hash of the AI agent result to be submitted, should be sha256 hash of the result, therefore needs to be in hex string format',
    ),
  blockchainIdentifier: z
    .string()
    .max(8000)
    .describe('The identifier of the payment'),
});

export const submitPaymentResultSchemaOutput = paymentResponseSchema.omit({
  TransactionHistory: true,
});

export const submitPaymentResultEndpointPost =
  readAuthenticatedEndpointFactory.build({
    method: 'post',
    input: submitPaymentResultSchemaInput,
    output: submitPaymentResultSchemaOutput,
    handler: async ({
      input,
      options,
    }: {
      input: z.infer<typeof submitPaymentResultSchemaInput>;
      options: {
        id: string;
        permission: $Enums.Permission;
        networkLimit: $Enums.Network[];
        usageLimited: boolean;
      };
    }) => {
      await checkIsAllowedNetworkOrThrowUnauthorized(
        options.networkLimit,
        input.network,
        options.permission,
      );

      const payment = await prisma.paymentRequest.findUnique({
        where: {
          onChainState: {
            in: [
              OnChainState.RefundRequested,
              OnChainState.Disputed,
              OnChainState.FundsLocked,
            ],
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

      if (
        payment.requestedById != options.id &&
        options.permission != Permission.Admin
      ) {
        throw createHttpError(
          403,
          'You are not authorized to submit results for this payment',
        );
      }

      // Update NextAction with history tracking
      await modifyPaymentNextAction(
        payment.id,
        PaymentAction.SubmitResultRequested,
        { resultHash: input.submitResultHash },
      );

      // Fetch the updated payment
      const result = await prisma.paymentRequest.findUnique({
        where: { id: payment.id },
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
        throw createHttpError(
          500,
          'Internal server error: Payment has no input hash',
        );
      }

      const decoded = decodeBlockchainIdentifier(result.blockchainIdentifier);

      if (!result) {
        throw createHttpError(500, 'Failed to fetch updated payment');
      }

      return {
        ...result,
        ...transformPaymentGetTimestamps(result),
        ...transformPaymentGetAmounts(result),
        totalBuyerCardanoFees:
          Number(result.totalBuyerCardanoFees.toString()) / 1_000_000,
        totalSellerCardanoFees:
          Number(result.totalSellerCardanoFees.toString()) / 1_000_000,
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
