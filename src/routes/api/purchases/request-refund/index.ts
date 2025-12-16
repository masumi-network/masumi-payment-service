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
  id: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
  blockchainIdentifier: z.string(),
  lastCheckedAt: z.date().nullable(),
  payByTime: z.string().nullable(),
  submitResultTime: z.string(),
  unlockTime: z.string(),
  externalDisputeUnlockTime: z.string(),
  requestedById: z.string(),
  resultHash: z.string(),
  onChainState: z.nativeEnum(OnChainState).nullable(),
  NextAction: z.object({
    requestedAction: z.nativeEnum(PurchasingAction),
    errorType: z.nativeEnum(PurchaseErrorType).nullable(),
    errorNote: z.string().nullable(),
  }),
  CurrentTransaction: z
    .object({
      id: z.string(),
      createdAt: z.date(),
      updatedAt: z.date(),
      txHash: z.string(),
      status: z.nativeEnum(TransactionStatus),
    })
    .nullable(),
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
  SellerWallet: z
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
            inputHash: purchase.inputHash,
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
