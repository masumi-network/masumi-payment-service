import { z } from 'zod';
import {
  Network,
  PaymentAction,
  TransactionStatus,
  $Enums,
} from '@prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';

export const paymentErrorStateRecoverySchemaInput = z.object({
  blockchainIdentifier: z
    .string()
    .min(1)
    .describe('The blockchain identifier of the payment request'),
  network: z
    .nativeEnum(Network)
    .describe('The network the transaction was made on'),
});

export const paymentErrorStateRecoverySchemaOutput = z.object({
  success: z.boolean(),
  message: z.string(),
  id: z.string(),
  currentTransactionId: z.string().nullable(),
  nextAction: z.object({
    requestedAction: z.literal(PaymentAction.WaitingForExternalAction),
    errorType: z.null(),
    errorNote: z.null(),
  }),
});

export const paymentErrorStateRecoveryPost =
  payAuthenticatedEndpointFactory.build({
    method: 'post',
    input: paymentErrorStateRecoverySchemaInput,
    output: paymentErrorStateRecoverySchemaOutput,
    handler: async ({
      input,
      options,
    }: {
      input: z.infer<typeof paymentErrorStateRecoverySchemaInput>;
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

      // Find payment request
      const paymentRequest = await prisma.paymentRequest.findFirst({
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

      if (!paymentRequest) {
        throw createHttpError(
          404,
          'Payment request not found with the provided blockchain identifier',
        );
      }

      // Validate that the request is in WaitingForManualAction with error
      if (
        paymentRequest.NextAction.requestedAction !==
        PaymentAction.WaitingForManualAction
      ) {
        throw createHttpError(
          400,
          `Payment request is not in WaitingForManualAction state. Current state: ${paymentRequest.NextAction.requestedAction}`,
        );
      }

      if (!paymentRequest.NextAction.errorType) {
        throw createHttpError(
          400,
          'Payment request is not in an error state. No error to clear.',
        );
      }

      // Find the most recent successful transaction (confirmed or pending)
      // Priority 1: Most recent Confirmed transaction (fully successful)
      const confirmedTransaction = paymentRequest.TransactionHistory.filter(
        (tx) => tx.status === TransactionStatus.Confirmed,
      ).sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )[0];

      // Priority 2: If no confirmed, get most recent Pending transaction (in progress)
      const pendingTransaction = !confirmedTransaction
        ? paymentRequest.TransactionHistory.filter(
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
      const updatedPaymentRequest = await prisma.paymentRequest.update({
        where: { id: paymentRequest.id },
        data: {
          currentTransactionId: lastSuccessfulTransaction?.id || null,
        },
        include: {
          NextAction: true,
        },
      });

      // Update the NextAction separately
      await prisma.paymentActionData.update({
        where: { id: updatedPaymentRequest.NextAction.id },
        data: {
          errorType: null,
          errorNote: null,
          requestedAction: PaymentAction.WaitingForExternalAction,
        },
      });

      return {
        success: true,
        message: 'Error state cleared successfully for payment request',
        id: updatedPaymentRequest.id,
        currentTransactionId: lastSuccessfulTransaction?.id || null,
        nextAction: {
          requestedAction: PaymentAction.WaitingForExternalAction,
          errorType: null,
          errorNote: null,
        },
      };
    },
  });
