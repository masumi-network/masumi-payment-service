import { z } from 'zod';
import {
  Network,
  OnChainState,
  $Enums,
  PaymentAction,
  PaymentErrorType,
  TransactionStatus,
} from '@prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';

export const postPaymentRequestSchemaInput = z.object({
  blockchainIdentifier: z
    .string()
    .describe('The blockchain identifier to resolve'),
  network: z
    .nativeEnum(Network)
    .describe('The network the purchases were made on'),
  filterSmartContractAddress: z
    .string()
    .optional()
    .nullable()
    .describe('The smart contract address of the payment source'),

  includeHistory: z
    .string()
    .optional()
    .transform((val) => val?.toLowerCase() == 'true')
    .default('false')
    .describe(
      'Whether to include the full transaction and status history of the purchases',
    ),
});

export const postPaymentRequestSchemaOutput = z.object({
  id: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
  blockchainIdentifier: z.string(),
  lastCheckedAt: z.date().nullable(),
  payByTime: z.string().nullable(),
  submitResultTime: z.string(),
  unlockTime: z.string(),
  collateralReturnLovelace: z.string().nullable(),
  externalDisputeUnlockTime: z.string(),
  requestedById: z.string(),
  resultHash: z.string(),
  inputHash: z.string(),
  cooldownTime: z.number(),
  cooldownTimeOtherParty: z.number(),
  onChainState: z.nativeEnum(OnChainState).nullable(),
  NextAction: z.object({
    requestedAction: z.nativeEnum(PaymentAction),
    errorType: z.nativeEnum(PaymentErrorType).nullable(),
    errorNote: z.string().nullable(),
    resultHash: z.string().nullable(),
  }),
  CurrentTransaction: z
    .object({
      id: z.string(),
      createdAt: z.date(),
      updatedAt: z.date(),
      txHash: z.string().nullable(),
      status: z.nativeEnum(TransactionStatus),
      previousOnChainState: z.nativeEnum(OnChainState).nullable(),
      newOnChainState: z.nativeEnum(OnChainState).nullable(),
    })
    .nullable(),
  TransactionHistory: z
    .array(
      z.object({
        id: z.string(),
        createdAt: z.date(),
        updatedAt: z.date(),
        txHash: z.string().nullable(),
        status: z.nativeEnum(TransactionStatus),
        previousOnChainState: z.nativeEnum(OnChainState).nullable(),
        newOnChainState: z.nativeEnum(OnChainState).nullable(),
      }),
    )
    .nullable(),
  RequestedFunds: z.array(
    z.object({
      amount: z.string(),
      unit: z.string(),
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

export const resolvePaymentRequestPost = readAuthenticatedEndpointFactory.build(
  {
    method: 'post',
    input: postPaymentRequestSchemaInput,
    output: postPaymentRequestSchemaOutput,
    handler: async ({
      input,
      options,
    }: {
      input: z.infer<typeof postPaymentRequestSchemaInput>;
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

      const result = await prisma.paymentRequest.findUnique({
        where: {
          PaymentSource: {
            deletedAt: null,
            network: input.network,
            smartContractAddress: input.filterSmartContractAddress ?? undefined,
          },
          blockchainIdentifier: input.blockchainIdentifier,
        },
        include: {
          BuyerWallet: true,
          SmartContractWallet: { where: { deletedAt: null } },
          RequestedFunds: true,
          NextAction: true,
          PaymentSource: true,
          CurrentTransaction: true,
          WithdrawnForSeller: true,
          WithdrawnForBuyer: true,
          TransactionHistory: {
            orderBy: { createdAt: 'desc' },
            take: input.includeHistory == true ? undefined : 0,
          },
        },
      });
      if (result == null) {
        throw createHttpError(404, 'Payment not found');
      }
      return {
        ...result,
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
        collateralReturnLovelace:
          result.collateralReturnLovelace?.toString() ?? null,
        payByTime: result.payByTime?.toString() ?? null,
        submitResultTime: result.submitResultTime.toString(),
        unlockTime: result.unlockTime.toString(),
        externalDisputeUnlockTime: result.externalDisputeUnlockTime.toString(),
        cooldownTime: Number(result.sellerCoolDownTime),
        cooldownTimeOtherParty: Number(result.buyerCoolDownTime),
      };
    },
  },
);
