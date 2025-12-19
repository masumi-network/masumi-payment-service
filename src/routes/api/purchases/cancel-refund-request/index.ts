import { z } from '@/utils/zod-openapi';
import {
  Network,
  PurchasingAction,
  OnChainState,
  Permission,
  $Enums,
} from '@prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { purchaseResponseSchema } from '@/routes/api/purchases';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';
import {
  transformPurchaseGetAmounts,
  transformPurchaseGetTimestamps,
} from '@/utils/shared/transformers';

export const cancelPurchaseRefundRequestSchemaInput = z.object({
  blockchainIdentifier: z
    .string()
    .max(8000)
    .describe('The identifier of the purchase to be refunded'),
  network: z
    .nativeEnum(Network)
    .describe('The network the Cardano wallet will be used on'),
});

export const cancelPurchaseRefundRequestSchemaOutput = purchaseResponseSchema;

export const cancelPurchaseRefundRequestPost =
  payAuthenticatedEndpointFactory.build({
    method: 'post',
    input: cancelPurchaseRefundRequestSchemaInput,
    output: cancelPurchaseRefundRequestSchemaOutput,
    handler: async ({
      input,
      options,
    }: {
      input: z.infer<typeof cancelPurchaseRefundRequestSchemaInput>;
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
        },
        include: {
          PaymentSource: {
            include: {
              FeeReceiverNetworkWallet: true,
              AdminWallets: true,
              PaymentSourceConfig: true,
            },
          },
          SellerWallet: true,
          SmartContractWallet: { where: { deletedAt: null } },
          NextAction: true,
          CurrentTransaction: true,
          TransactionHistory: true,
          PaidFunds: true,
        },
      });
      if (purchase == null) {
        throw createHttpError(404, 'Purchase not found or in invalid state');
      }
      if (purchase.PaymentSource == null) {
        throw createHttpError(400, 'Purchase has no payment source');
      }
      if (purchase.PaymentSource.network != input.network) {
        throw createHttpError(
          400,
          'Purchase was not made on the requested network',
        );
      }
      if (purchase.PaymentSource.deletedAt != null) {
        throw createHttpError(400, 'Payment source is deleted');
      }
      if (
        purchase.requestedById != options.id &&
        options.permission != Permission.Admin
      ) {
        throw createHttpError(
          403,
          'You are not authorized to cancel a refund request for this purchase',
        );
      }
      if (purchase.CurrentTransaction == null) {
        throw createHttpError(400, 'Purchase in invalid state');
      }
      if (purchase.CurrentTransaction.txHash == null) {
        throw createHttpError(400, 'Purchase in invalid state');
      }
      if (purchase.SmartContractWallet == null) {
        throw createHttpError(404, 'Smart contract wallet not set on purchase');
      }

      const result = await prisma.purchaseRequest.update({
        where: { id: purchase.id },
        data: {
          NextAction: {
            update: {
              requestedAction: PurchasingAction.UnSetRefundRequestedRequested,
            },
          },
        },
        include: {
          NextAction: true,
          CurrentTransaction: true,
          TransactionHistory: true,
          PaidFunds: true,
          PaymentSource: true,
          SellerWallet: true,
          SmartContractWallet: { where: { deletedAt: null } },
          WithdrawnForSeller: true,
          WithdrawnForBuyer: true,
        },
      });

      const decoded = decodeBlockchainIdentifier(result.blockchainIdentifier);

      return {
        ...result,
        ...transformPurchaseGetTimestamps(result),
        ...transformPurchaseGetAmounts(result),
        agentIdentifier: decoded?.agentIdentifier ?? null,
        CurrentTransaction: result.CurrentTransaction
          ? {
              ...result.CurrentTransaction,
              fees: result.CurrentTransaction.fees?.toString() ?? null,
            }
          : null,
        TransactionHistory: result.TransactionHistory.map((tx) => ({
          ...tx,
          fees: tx.fees?.toString() ?? null,
        })),
      };
    },
  });
