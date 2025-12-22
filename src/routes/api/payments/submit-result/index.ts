import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import { WalletAccess } from '@/services/wallet-access';
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

export const submitPaymentResultSchemaOutput = paymentResponseSchema;

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
        allowedWalletIds: string[];
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
        },
        include: {
          PaymentSource: {
            include: {
              HotWallets: { where: { deletedAt: null } },
              PaymentSourceConfig: true,
            },
          },
          NextAction: true,
          SmartContractWallet: { where: { deletedAt: null } },
        },
      });
      if (payment == null) {
        throw createHttpError(404, 'Payment not found or in invalid state');
      }
      if (payment.PaymentSource == null) {
        throw createHttpError(404, 'Payment has no payment source');
      }
      if (payment.PaymentSource.deletedAt != null) {
        throw createHttpError(404, 'Payment source is deleted');
      }
      if (payment.PaymentSource.network != input.network) {
        throw createHttpError(
          400,
          'Payment was not made on the requested network',
        );
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
      if (payment.SmartContractWallet == null) {
        throw createHttpError(404, 'Smart contract wallet not found');
      }

      // Validate wallet access for WalletScoped keys
      await WalletAccess.validateResourceAccess(
        {
          apiKeyId: options.id,
          permission: options.permission,
          allowedWalletIds: options.allowedWalletIds,
        },
        payment.SmartContractWallet,
      );

      const result = await prisma.paymentRequest.update({
        where: { id: payment.id },
        data: {
          NextAction: {
            update: {
              requestedAction: PaymentAction.SubmitResultRequested,
              resultHash: input.submitResultHash,
            },
          },
        },
        include: {
          NextAction: true,
          BuyerWallet: true,
          SmartContractWallet: { where: { deletedAt: null } },
          PaymentSource: true,
          CurrentTransaction: true,
          RequestedFunds: true,
          WithdrawnForSeller: true,
          WithdrawnForBuyer: true,
          TransactionHistory: true,
        },
      });
      if (result.inputHash == null) {
        throw createHttpError(
          500,
          'Internal server error: Payment has no input hash',
        );
      }

      const decoded = decodeBlockchainIdentifier(result.blockchainIdentifier);
      return {
        ...result,
        ...transformPaymentGetTimestamps(result),
        ...transformPaymentGetAmounts(result),
        agentIdentifier: decoded?.agentIdentifier ?? null,
        CurrentTransaction: result.CurrentTransaction
          ? {
              ...result.CurrentTransaction,
              fees: result.CurrentTransaction.fees?.toString() ?? null,
            }
          : null,
        TransactionHistory: result.TransactionHistory
          ? result.TransactionHistory.map((tx) => ({
              ...tx,
              fees: tx.fees?.toString() ?? null,
            }))
          : null,
      };
    },
  });
