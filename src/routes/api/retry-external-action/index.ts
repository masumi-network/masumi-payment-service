import { z } from 'zod';
import {
  Network,
  PaymentAction,
  PurchasingAction,
  TransactionStatus,
  $Enums,
} from '@prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';

export const retryExternalActionSchemaInput = z.object({
  blockchainIdentifier: z
    .string()
    .min(1)
    .describe('The blockchain identifier of the payment or purchase request'),
  network: z
    .nativeEnum(Network)
    .describe('The network the transaction was made on'),
});

export const retryExternalActionSchemaOutput = z.object({
  success: z.boolean(),
  message: z.string(),
  type: z.enum(['payment', 'purchase']),
  id: z.string(),
  currentTransactionId: z.string().nullable(),
  nextAction: z.object({
    requestedAction: z.enum([
      PaymentAction.WaitingForExternalAction,
      PurchasingAction.WaitingForExternalAction,
    ]),
    errorType: z.null(),
    errorNote: z.null(),
  }),
});

export const retryExternalActionPost = payAuthenticatedEndpointFactory.build({
  method: 'post',
  input: retryExternalActionSchemaInput,
  output: retryExternalActionSchemaOutput,
  handler: async ({
    input,
    options,
  }: {
    input: z.infer<typeof retryExternalActionSchemaInput>;
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

    // Try to find payment request first
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

    // Try to find purchase request if payment not found
    const purchaseRequest = !paymentRequest
      ? await prisma.purchaseRequest.findFirst({
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
        })
      : null;

    const request = paymentRequest || purchaseRequest;
    const isPayment = !!paymentRequest;

    if (!request) {
      throw createHttpError(
        404,
        'No payment or purchase request found with the provided blockchain identifier',
      );
    }

    // Validate that the request is in WaitingForExternalAction with error
    const isInWaitingForExternalAction =
      (isPayment &&
        request.NextAction.requestedAction ===
          PaymentAction.WaitingForExternalAction) ||
      (!isPayment &&
        request.NextAction.requestedAction ===
          PurchasingAction.WaitingForExternalAction);

    if (!isInWaitingForExternalAction) {
      throw createHttpError(
        400,
        `Request is not in WaitingForExternalAction state. Current state: ${request.NextAction.requestedAction}`,
      );
    }

    if (!request.NextAction.errorType) {
      throw createHttpError(
        400,
        'Request is not in an error state. No error to clear.',
      );
    }

    // Find the most recent confirmed transaction
    const confirmedTransaction = request.TransactionHistory.find(
      (tx) => tx.status === TransactionStatus.Confirmed,
    );

    // Update the request to clear error and set confirmed transaction
    if (isPayment) {
      const updatedPaymentRequest = await prisma.paymentRequest.update({
        where: { id: request.id },
        data: {
          currentTransactionId: confirmedTransaction?.id || null,
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
        type: 'payment' as const,
        id: updatedPaymentRequest.id,
        currentTransactionId: confirmedTransaction?.id || null,
        nextAction: {
          requestedAction: PaymentAction.WaitingForExternalAction,
          errorType: null,
          errorNote: null,
        },
      };
    } else {
      const updatedPurchaseRequest = await prisma.purchaseRequest.update({
        where: { id: request.id },
        data: {
          currentTransactionId: confirmedTransaction?.id || null,
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
        type: 'purchase' as const,
        id: updatedPurchaseRequest.id,
        currentTransactionId: confirmedTransaction?.id || null,
        nextAction: {
          requestedAction: PurchasingAction.WaitingForExternalAction,
          errorType: null,
          errorNote: null,
        },
      };
    }
  },
});
