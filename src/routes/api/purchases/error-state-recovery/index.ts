import { z } from 'zod';
import {
  Network,
  PurchasingAction,
  TransactionStatus,
  $Enums,
  OnChainState,
} from '@prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { logger } from '@/utils/logger';
import { ez } from 'express-zod-api';

export const purchaseErrorStateRecoverySchemaInput = z.object({
  blockchainIdentifier: z
    .string()
    .min(1)
    .describe('The blockchain identifier of the purchase request'),
  network: z
    .nativeEnum(Network)
    .describe('The network the transaction was made on'),
  updatedAt: ez
    .dateIn()
    .describe(
      'The time of the last update, to ensure you clear the correct error state',
    ),
});

export const purchaseErrorStateRecoverySchemaOutput = z.object({
  id: z.string(),
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
          updatedAt: input.updatedAt,
          PaymentSource: {
            network: input.network,
            deletedAt: null,
          },
        },
        include: {
          NextAction: true,
          CurrentTransaction: true,
          TransactionHistory: {
            orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          },
        },
      });

      if (!purchaseRequest) {
        throw createHttpError(
          404,
          'Purchase request not found with the provided blockchain identifier or it was changed',
        );
      }
      if (!purchaseRequest.onChainState) {
        throw createHttpError(
          400,
          'Purchase request is in its initial on-chain state. Can not be recovered. Please start a new purchase request.',
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
      const confirmedTransactions = purchaseRequest.TransactionHistory.filter(
        (tx) => tx.status === TransactionStatus.Confirmed,
      );
      const mostRecentConfirmedTransaction =
        confirmedTransactions.length > 0 ? confirmedTransactions[0] : undefined;

      // Priority 2: If no confirmed, get most recent Pending transaction (in progress)
      const pendingTransactions = purchaseRequest.TransactionHistory.filter(
        (tx) => tx.status === TransactionStatus.Pending,
      );
      const mostRecentPendingTransaction =
        pendingTransactions.length > 0 ? pendingTransactions[0] : undefined;

      // Use the best available transaction
      const lastSuccessfulTransaction =
        mostRecentConfirmedTransaction ?? mostRecentPendingTransaction;

      const transactionsToFail = purchaseRequest.TransactionHistory.filter(
        (tx) => {
          if (tx.status !== TransactionStatus.Pending) return false;

          if (
            lastSuccessfulTransaction &&
            tx.id === lastSuccessfulTransaction.id
          ) {
            return false;
          }

          if (!lastSuccessfulTransaction) return true;

          return (
            new Date(tx.createdAt).getTime() >=
            new Date(lastSuccessfulTransaction.createdAt).getTime()
          );
        },
      );

      logger.info('Error state recovery initiated', {
        purchaseRequestId: purchaseRequest.id,
        blockchainIdentifier: input.blockchainIdentifier,
        lastSuccessfulTransactionId: lastSuccessfulTransaction?.id || null,
        lastSuccessfulTransactionStatus:
          lastSuccessfulTransaction?.status || null,
        transactionsToFailCount: transactionsToFail.length,
        transactionsToFailIds: transactionsToFail.map((tx) => tx.id),
      });

      await prisma.$transaction(async (tx) => {
        for (const transaction of transactionsToFail) {
          await tx.transaction.update({
            where: { id: transaction.id },
            data: { status: TransactionStatus.FailedViaManualReset },
          });
        }

        await tx.purchaseRequest.update({
          where: { id: purchaseRequest.id },
          data: { currentTransactionId: lastSuccessfulTransaction?.id || null },
        });

        const isCompletedState =
          purchaseRequest.onChainState &&
          (
            [
              OnChainState.Withdrawn,
              OnChainState.RefundWithdrawn,
              OnChainState.DisputedWithdrawn,
            ] as OnChainState[]
          ).includes(purchaseRequest.onChainState);

        await tx.purchaseRequest.update({
          where: { id: purchaseRequest.id },
          data: {
            NextAction: {
              create: {
                submittedTxHash: null,
                requestedAction: isCompletedState
                  ? PurchasingAction.None
                  : PurchasingAction.WaitingForExternalAction,
              },
            },
          },
        });
      });

      logger.info('Error state recovery completed successfully', {
        purchaseRequestId: purchaseRequest.id,
        failedTransactionsCount: transactionsToFail.length,
      });

      return {
        id: purchaseRequest.id,
      };
    },
  });
