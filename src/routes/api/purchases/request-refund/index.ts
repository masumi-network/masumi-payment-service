import { z } from 'zod';
import {
  Network,
  PurchasingAction,
  TransactionStatus,
  OnChainState,
  PurchaseErrorType,
  Permission,
  $Enums,
} from '@prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';

export const requestPurchaseRefundSchemaInput = z.object({
  blockchainIdentifier: z
    .string()
    .max(8000)
    .describe('The identifier of the purchase to be refunded'),
  network: z
    .nativeEnum(Network)
    .describe('The network the Cardano wallet will be used on'),
});

export const requestPurchaseRefundSchemaOutput = z.object({
  id: z.string().describe('Unique identifier for the purchase'),
  createdAt: z.date().describe('Timestamp when the purchase was created'),
  updatedAt: z.date().describe('Timestamp when the purchase was last updated'),
  blockchainIdentifier: z
    .string()
    .describe('Unique blockchain identifier for the purchase'),
  lastCheckedAt: z
    .date()
    .nullable()
    .describe(
      'Timestamp when the purchase was last checked on-chain. Null if never checked',
    ),
  payByTime: z
    .string()
    .nullable()
    .describe(
      'Unix timestamp by which the buyer must submit the payment transaction. Null if not set',
    ),
  submitResultTime: z
    .string()
    .describe('Unix timestamp by which the seller must submit the result'),
  unlockTime: z
    .string()
    .describe(
      'Unix timestamp after which funds can be unlocked if no disputes',
    ),
  externalDisputeUnlockTime: z
    .string()
    .describe(
      'Unix timestamp after which external dispute resolution can occur',
    ),
  requestedById: z
    .string()
    .describe('ID of the API key that created this purchase'),
  resultHash: z
    .string()
    .nullable()
    .describe('SHA256 hash of the result submitted by the seller (hex string)'),
  onChainState: z
    .nativeEnum(OnChainState)
    .nullable()
    .describe(
      'Current state of the purchase on the blockchain. Null if not yet on-chain',
    ),
  NextAction: z
    .object({
      requestedAction: z
        .nativeEnum(PurchasingAction)
        .describe('Next action required for this purchase'),
      errorType: z
        .nativeEnum(PurchaseErrorType)
        .nullable()
        .describe('Type of error that occurred, if any'),
      errorNote: z
        .string()
        .nullable()
        .describe('Additional details about the error, if any'),
    })
    .describe('Next action required for this purchase'),
  CurrentTransaction: z
    .object({
      id: z.string().describe('Unique identifier for the transaction'),
      createdAt: z
        .date()
        .describe('Timestamp when the transaction was created'),
      updatedAt: z
        .date()
        .describe('Timestamp when the transaction was last updated'),
      txHash: z.string().nullable().describe('Cardano transaction hash'),
      status: z
        .nativeEnum(TransactionStatus)
        .describe('Current status of the transaction'),
    })
    .nullable()
    .describe(
      'Current active transaction for this purchase. Null if no transaction in progress',
    ),
  PaidFunds: z.array(
    z.object({
      amount: z
        .string()
        .describe(
          'The quantity of the asset. Make sure to convert it from the underlying smallest unit (in case of decimals, multiply it by the decimal factor e.g. for 1 ADA = 10000000 lovelace)',
        ),
      unit: z
        .string()
        .describe(
          'Asset policy id + asset name concatenated. Uses an empty string for ADA/lovelace e.g (1000000 lovelace = 1 ADA)',
        ),
    }),
  ),
  WithdrawnForSeller: z
    .array(
      z.object({
        amount: z
          .string()
          .describe(
            'Amount of the asset withdrawn (as string to handle large numbers)',
          ),
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
        amount: z
          .string()
          .describe(
            'Amount of the asset withdrawn (as string to handle large numbers)',
          ),
        unit: z
          .string()
          .describe(
            'Asset policy id + asset name concatenated. Empty string for ADA/lovelace',
          ),
      }),
    )
    .describe('List of assets and amounts withdrawn for the buyer (refunds)'),
  PaymentSource: z
    .object({
      id: z.string().describe('Unique identifier for the payment source'),
      network: z.nativeEnum(Network).describe('The Cardano network'),
      policyId: z
        .string()
        .nullable()
        .describe(
          'Policy ID for the agent registry NFTs. Null if not applicable',
        ),
      smartContractAddress: z
        .string()
        .describe('Address of the smart contract managing this purchase'),
    })
    .describe('Payment source configuration for this purchase'),
  SellerWallet: z
    .object({
      id: z.string().describe('Unique identifier for the seller wallet'),
      walletVkey: z.string().describe('Payment key hash of the seller wallet'),
    })
    .nullable()
    .describe('Seller wallet information. Null if not set'),
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
      'Smart contract wallet (seller wallet) managing this purchase. Null if not set',
    ),
  metadata: z
    .string()
    .nullable()
    .describe(
      'Optional metadata stored with the purchase for additional context. Null if not provided',
    ),
});

export const requestPurchaseRefundPost = payAuthenticatedEndpointFactory.build({
  method: 'post',
  input: requestPurchaseRefundSchemaInput,
  output: requestPurchaseRefundSchemaOutput,
  handler: async ({
    input,
    options,
  }: {
    input: z.infer<typeof requestPurchaseRefundSchemaInput>;
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
          in: [OnChainState.ResultSubmitted, OnChainState.FundsLocked],
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
      throw createHttpError(404, 'Purchase not found or not in valid state');
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
        'You are not authorized to request a refund for this purchase',
      );
    }
    if (purchase.CurrentTransaction == null) {
      throw createHttpError(400, 'Purchase in invalid state');
    }

    if (purchase.SmartContractWallet == null) {
      throw createHttpError(404, 'Smart contract wallet not set on purchase');
    }

    const result = await prisma.purchaseRequest.update({
      where: { id: purchase.id },
      data: {
        NextAction: {
          create: {
            requestedAction: PurchasingAction.SetRefundRequestedRequested,
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
    return {
      ...result,
      submitResultTime: result.submitResultTime.toString(),
      payByTime: result.payByTime?.toString() ?? null,
      unlockTime: result.unlockTime.toString(),
      externalDisputeUnlockTime: result.externalDisputeUnlockTime.toString(),
      PaidFunds: (
        result.PaidFunds as Array<{ unit: string; amount: bigint }>
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
