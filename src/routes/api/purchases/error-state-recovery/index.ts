import { z } from 'zod';
import {
  Network,
  PurchasingAction,
  TransactionStatus,
  $Enums,
} from '@prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';

export const purchaseErrorStateRecoverySchemaInput = z.object({
  blockchainIdentifier: z
    .string()
    .min(1)
    .describe('The blockchain identifier of the purchase request'),
  network: z
    .nativeEnum(Network)
    .describe('The network the transaction was made on'),
});

export const purchaseErrorStateRecoverySchemaOutput = z.object({
  success: z.boolean(),
  message: z.string(),
  id: z.string(),
  currentTransactionId: z.string().nullable(),
  nextAction: z.object({
    requestedAction: z.literal(PurchasingAction.WaitingForExternalAction),
    errorType: z.null(),
    errorNote: z.null(),
  }),
});

export const purchaseErrorStateRecoveryPost =
  payAuthenticatedEndpointFactory.build({
    method: 'post',
    input: purchaseErrorStateRecoverySchemaInput,
    output: purchaseErrorStateRecoverySchemaOutput,
    handler: async ({
      input,
      options,
    }: {
      input: z.infer<typeof purchaseErrorStateRecoverySchemaInput>;
      options: {
        id: string;
        permission: $Enums.Permission;
        networkLimit: $Enums.Network[];
        usageLimited: boolean;
      };
    }) => {
      // Check network permission
      await checkIsAllowedNetworkOrThrowUnauthorized(
        options.networkLimit,
        input.network,
        options.permission,
      );

      // Find purchase request
      const purchaseRequest = await prisma.purchaseRequest.findFirst({
        where: {
          blockchainIdentifier: input.blockchainIdentifier,
          PaymentSource: {
            network: input.network,
            deletedAt: null,
          },
        },
        include: {
          NextAction: true,
          CurrentTransaction: true,
          TransactionHistory: {
            orderBy: { createdAt: 'desc' },
          },
        },
      });

      if (!purchaseRequest) {
        throw createHttpError(
          404,
          'Purchase request not found with the provided blockchain identifier',
        );
      }

      // Validate that the request is in WaitingForManualAction with error
      if (
        purchaseRequest.NextAction.requestedAction !==
        PurchasingAction.WaitingForManualAction
      ) {
        throw createHttpError(
          400,
          `Purchase request is not in WaitingForManualAction state. Current state: ${purchaseRequest.NextAction.requestedAction}`,
        );
      }

      if (!purchaseRequest.NextAction.errorType) {
        throw createHttpError(
          400,
          'Purchase request is not in an error state. No error to clear.',
        );
      }

      // Find the most recent successful transaction (confirmed or pending)
      // Priority 1: Most recent Confirmed transaction (fully successful)
      const confirmedTransaction = purchaseRequest.TransactionHistory.filter(
        (tx) => tx.status === TransactionStatus.Confirmed,
      ).sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )[0];

      // Priority 2: If no confirmed, get most recent Pending transaction (in progress)
      const pendingTransaction = !confirmedTransaction
        ? purchaseRequest.TransactionHistory.filter(
            (tx) => tx.status === TransactionStatus.Pending,
          ).sort(
            (a, b) =>
              new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
          )[0]
        : null;

      // Use the best available transaction
      const lastSuccessfulTransaction =
        confirmedTransaction || pendingTransaction;

      // Update the request to clear error and set last successful transaction
      const updatedPurchaseRequest = await prisma.purchaseRequest.update({
        where: { id: purchaseRequest.id },
        data: {
          currentTransactionId: lastSuccessfulTransaction?.id || null,
        },
        include: {
          NextAction: true,
        },
      });

      // Update the NextAction separately
      await prisma.purchaseActionData.update({
        where: { id: updatedPurchaseRequest.NextAction.id },
        data: {
          errorType: null,
          errorNote: null,
          requestedAction: PurchasingAction.WaitingForExternalAction,
        },
      });

      return {
        success: true,
        message: 'Error state cleared successfully for purchase request',
        id: updatedPurchaseRequest.id,
        currentTransactionId: lastSuccessfulTransaction?.id || null,
        nextAction: {
          requestedAction: PurchasingAction.WaitingForExternalAction,
          errorType: null,
          errorNote: null,
        },
      };
    },
  });
