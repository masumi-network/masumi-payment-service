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

export const authorizePaymentRefundSchemaInput = z.object({
  blockchainIdentifier: z
    .string()
    .max(8000)
    .describe('The identifier of the purchase to be refunded'),
  network: z
    .nativeEnum(Network)
    .describe('The network the Cardano wallet will be used on'),
});

export const authorizePaymentRefundSchemaOutput = paymentResponseSchema;

export const authorizePaymentRefundEndpointPost =
  readAuthenticatedEndpointFactory.build({
    method: 'post',
    input: authorizePaymentRefundSchemaInput,
    output: authorizePaymentRefundSchemaOutput,
    handler: async ({
      input,
      options,
    }: {
      input: z.infer<typeof authorizePaymentRefundSchemaInput>;
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
          blockchainIdentifier: input.blockchainIdentifier,
          NextAction: {
            requestedAction: {
              in: [PaymentAction.WaitingForExternalAction],
            },
          },
          onChainState: {
            in: [OnChainState.Disputed, OnChainState.RefundRequested],
          },
        },
        include: {
          PaymentSource: {
            include: {
              FeeReceiverNetworkWallet: true,
              AdminWallets: true,
              PaymentSourceConfig: true,
            },
          },

          BuyerWallet: true,
          SmartContractWallet: { where: { deletedAt: null } },
          NextAction: true,
          CurrentTransaction: true,
          TransactionHistory: true,
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

      if (payment.CurrentTransaction == null) {
        throw createHttpError(400, 'Payment in invalid state');
      }
      if (
        payment.requestedById != options.id &&
        options.permission != Permission.Admin
      ) {
        throw createHttpError(
          403,
          'You are not authorized to authorize a refund for this payment',
        );
      }
      const result = await prisma.paymentRequest.update({
        where: { id: payment.id },
        data: {
          NextAction: {
            update: {
              requestedAction: PaymentAction.AuthorizeRefundRequested,
            },
          },
        },
        include: {
          NextAction: true,
          BuyerWallet: true,
          SmartContractWallet: { where: { deletedAt: null } },
          PaymentSource: true,
          RequestedFunds: true,
          WithdrawnForSeller: true,
          WithdrawnForBuyer: true,
          CurrentTransaction: true,
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
