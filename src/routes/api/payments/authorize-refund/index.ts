import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import { z } from 'zod';
import {
  $Enums,
  Network,
  OnChainState,
  PaymentAction,
  PaymentErrorType,
  Permission,
} from '@prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { modifyPaymentNextAction } from '@/utils/action-history';

export const authorizePaymentRefundSchemaInput = z.object({
  blockchainIdentifier: z
    .string()
    .max(8000)
    .describe('The identifier of the purchase to be refunded'),
  network: z
    .nativeEnum(Network)
    .describe('The network the Cardano wallet will be used on'),
});

export const authorizePaymentRefundSchemaOutput = z.object({
  id: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
  blockchainIdentifier: z.string(),
  payByTime: z.string().nullable(),
  submitResultTime: z.string(),
  unlockTime: z.string(),
  externalDisputeUnlockTime: z.string(),
  lastCheckedAt: z.date().nullable(),
  requestedById: z.string(),
  resultHash: z.string(),
  inputHash: z.string(),
  onChainState: z.nativeEnum(OnChainState).nullable(),
  NextAction: z.object({
    requestedAction: z.nativeEnum(PaymentAction),
    errorType: z.nativeEnum(PaymentErrorType).nullable(),
    errorNote: z.string().nullable(),
    resultHash: z.string().nullable(),
  }),
  RequestedFunds: z.array(
    z.object({
      amount: z
        .string()
        .describe(
          'The quantity of the asset. Make sure to convert it from the underlying smallest unit (in case of decimals, multiply it by the decimal factor e.g. for 1 ADA = 10000000 lovelace)',
        ),
      unit: z
        .string()
        .describe(
          'Asset policy id + asset name concatenated. Use an empty string for ADA/lovelace e.g (1000000 lovelace = 1 ADA)',
        ),
    }),
  ),
  WithdrawnForSeller: z.array(
    z.object({
      amount: z.string(),
      unit: z.string(),
    }),
  ),
  WithdrawnForBuyer: z.array(
    z.object({
      amount: z.string(),
      unit: z.string(),
    }),
  ),
  PaymentSource: z.object({
    id: z.string(),
    network: z.nativeEnum(Network),
    smartContractAddress: z.string(),
    policyId: z.string().nullable(),
  }),
  BuyerWallet: z
    .object({
      id: z.string(),
      walletVkey: z.string(),
    })
    .nullable(),
  SmartContractWallet: z
    .object({
      id: z.string(),
      walletVkey: z.string(),
      walletAddress: z.string(),
    })
    .nullable(),
  metadata: z.string().nullable(),
});

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

      // Update NextAction with history tracking
      await modifyPaymentNextAction(
        payment.id,
        PaymentAction.AuthorizeRefundRequested,
      );

      const result = await prisma.paymentRequest.findUnique({
        where: { id: payment.id },
        include: {
          NextAction: true,
          BuyerWallet: true,
          SmartContractWallet: { where: { deletedAt: null } },
          PaymentSource: true,
          RequestedFunds: true,
          WithdrawnForSeller: true,
          WithdrawnForBuyer: true,
        },
      });

      if (!result) {
        throw createHttpError(500, 'Failed to fetch updated payment');
      }

      return {
        ...result,
        submitResultTime: result.submitResultTime.toString(),
        payByTime: result.payByTime?.toString() ?? null,
        unlockTime: result.unlockTime.toString(),
        externalDisputeUnlockTime: result.externalDisputeUnlockTime.toString(),
        RequestedFunds: (
          result.RequestedFunds as Array<{ unit: string; amount: bigint }>
        ).map((amount) => ({
          ...amount,
          amount: amount.amount.toString(),
        })),
        WithdrawnForSeller: (
          result.WithdrawnForSeller as Array<{ unit: string; amount: bigint }>
        ).map((amount) => ({
          unit: amount.unit,
          amount: amount.amount.toString(),
        })),
        WithdrawnForBuyer: (
          result.WithdrawnForBuyer as Array<{ unit: string; amount: bigint }>
        ).map((amount) => ({
          unit: amount.unit,
          amount: amount.amount.toString(),
        })),
      };
    },
  });
