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
  id: z.string().describe('Unique identifier for the payment'),
  createdAt: z.date().describe('Timestamp when the payment was created'),
  updatedAt: z.date().describe('Timestamp when the payment was last updated'),
  blockchainIdentifier: z
    .string()
    .describe('Unique blockchain identifier for the payment'),
  payByTime: z
    .string()
    .nullable()
    .describe(
      'Unix timestamp (in milliseconds) by which the buyer must submit the payment transaction. Null if not set',
    ),
  submitResultTime: z
    .string()
    .describe(
      'Unix timestamp (in milliseconds) by which the seller must submit the result',
    ),
  unlockTime: z
    .string()
    .describe(
      'Unix timestamp (in milliseconds) after which funds can be unlocked if no disputes',
    ),
  externalDisputeUnlockTime: z
    .string()
    .describe(
      'Unix timestamp (in milliseconds) after which external dispute resolution can occur',
    ),
  lastCheckedAt: z
    .date()
    .nullable()
    .describe(
      'Timestamp when the payment was last checked on-chain. Null if never checked',
    ),
  requestedById: z
    .string()
    .describe('ID of the API key that created this payment'),
  resultHash: z
    .string()
    .nullable()
    .describe('SHA256 hash of the result submitted by the seller (hex string)'),
  inputHash: z
    .string()
    .describe('SHA256 hash of the input data for the payment (hex string)'),
  onChainState: z
    .nativeEnum(OnChainState)
    .nullable()
    .describe(
      'Current state of the payment on the blockchain. Null if not yet on-chain',
    ),
  NextAction: z
    .object({
      requestedAction: z
        .nativeEnum(PaymentAction)
        .describe('Next action required for this payment'),
      errorType: z
        .nativeEnum(PaymentErrorType)
        .nullable()
        .describe('Type of error that occurred, if any'),
      errorNote: z
        .string()
        .nullable()
        .describe('Additional details about the error, if any'),
      resultHash: z
        .string()
        .nullable()
        .describe(
          'SHA256 hash of the result to be submitted (hex string). Null if not applicable',
        ),
    })
    .describe('Next action required for this payment'),
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
  WithdrawnForSeller: z
    .array(
      z.object({
        amount: z.string().describe('Amount of the asset withdrawn'),
        unit: z
          .string()
          .describe(
            'Asset policy id + asset name concatenated. Empty string for ADA/lovelace',
          ),
      }),
    )
    .describe('List of assets and amounts withdrawn for the seller'),
  WithdrawnForBuyer: z
    .array(
      z.object({
        amount: z.string().describe('Amount of the asset withdrawn'),
        unit: z
          .string()
          .describe(
            'Asset policy id + asset name concatenated. Empty string for ADA/lovelace',
          ),
      }),
    )
    .describe('List of assets and amounts withdrawn for the buyer'),
  PaymentSource: z
    .object({
      id: z.string().describe('Unique identifier for the payment source'),
      network: z
        .nativeEnum(Network)
        .describe('The Cardano network (Mainnet, Preprod, or Preview)'),
      smartContractAddress: z
        .string()
        .describe('Address of the smart contract managing this payment'),
      policyId: z
        .string()
        .nullable()
        .describe(
          'Policy ID for the agent registry NFTs. Null if not applicable',
        ),
    })
    .describe('Payment source configuration for this payment'),
  BuyerWallet: z
    .object({
      id: z.string().describe('Unique identifier for the buyer wallet'),
      walletVkey: z.string().describe('Payment key hash of the buyer wallet'),
    })
    .nullable()
    .describe(
      'Buyer wallet information. Null if buyer has not yet submitted payment',
    ),
  SmartContractWallet: z
    .object({
      id: z
        .string()
        .describe('Unique identifier for the smart contract wallet'),
      walletVkey: z
        .string()
        .describe('Payment key hash of the smart contract wallet'),
      walletAddress: z
        .string()
        .describe('Cardano address of the smart contract wallet'),
    })
    .nullable()
    .describe(
      'Smart contract wallet (seller wallet) managing this payment. Null if not set',
    ),
  metadata: z
    .string()
    .nullable()
    .describe(
      'Optional metadata stored with the payment for additional context. Null if not provided',
    ),
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
        },
      });
      if (result.inputHash == null) {
        throw createHttpError(
          500,
          'Internal server error: Payment has no input hash',
        );
      }

      return {
        ...result,
        submitResultTime: result.submitResultTime.toString(),
        payByTime: result.payByTime?.toString() ?? null,
        unlockTime: result.unlockTime.toString(),
        inputHash: result.inputHash,
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
