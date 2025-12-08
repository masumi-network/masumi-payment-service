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

export const submitPaymentResultSchemaOutput = z.object({
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
    policyId: z.string().nullable(),
    smartContractAddress: z.string(),
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
        payByTime: result.payByTime?.toString() ?? null,
        submitResultTime: result.submitResultTime.toString(),
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
