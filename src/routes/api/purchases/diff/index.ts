import { z } from '@/utils/zod-openapi';
import { prisma } from '@/utils/db';
import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { $Enums, Network, Prisma } from '@/generated/prisma/client';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import createHttpError from 'http-errors';
import { queryPurchaseRequestSchemaOutput } from '@/routes/api/purchases';
import {
  transformPurchaseGetAmounts,
  transformPurchaseGetTimestamps,
} from '@/utils/shared/transformers';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';

type PurchaseDiffMode =
  | 'nextActionLastChangedAt'
  | 'onChainStateOrResultLastChangedAt'
  | 'nextActionOrOnChainStateOrResultLastChangedAt';

export const queryPurchaseDiffSchemaInput = z.object({
  limit: z
    .number({ coerce: true })
    .min(1)
    .max(100)
    .default(10)
    .describe('The number of purchases to return'),
  cursorId: z
    .string()
    .optional()
    .describe(
      'Pagination cursor (purchase id). Used as tie-breaker when lastUpdate equals a purchase change timestamp',
    ),
  lastUpdate: z
    .string()
    .optional()
    .default(new Date(0).toISOString())
    .transform((val) => new Date(val))
    .refine((d) => !Number.isNaN(d.getTime()), {
      message: 'lastUpdate must be a valid ISO date string',
    })
    .describe(
      'Return purchases whose selected status timestamp changed after this ISO timestamp',
    ),
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

function buildPurchaseDiffWhere({
  mode,
  since,
  sinceId,
  network,
  filterSmartContractAddress,
}: {
  mode: PurchaseDiffMode;
  since: Date;
  sinceId?: string;
  network: Prisma.PaymentSourceWhereInput['network'];
  filterSmartContractAddress?: string | null;
}): Prisma.PurchaseRequestWhereInput {
  const base: Prisma.PurchaseRequestWhereInput = {
    PaymentSource: {
      deletedAt: null,
      network,
      smartContractAddress: filterSmartContractAddress ?? undefined,
    },
  };

  switch (mode) {
    case 'nextActionLastChangedAt':
      return sinceId != null
        ? {
            ...base,
            OR: [
              { nextActionLastChangedAt: { gt: since } },
              { nextActionLastChangedAt: since, id: { gte: sinceId } },
            ],
          }
        : { ...base, nextActionLastChangedAt: { gte: since } };
    case 'onChainStateOrResultLastChangedAt':
      return sinceId != null
        ? {
            ...base,
            OR: [
              { onChainStateOrResultLastChangedAt: { gt: since } },
              {
                onChainStateOrResultLastChangedAt: since,
                id: { gte: sinceId },
              },
            ],
          }
        : { ...base, onChainStateOrResultLastChangedAt: { gte: since } };
    case 'nextActionOrOnChainStateOrResultLastChangedAt':
      return sinceId != null
        ? {
            ...base,
            OR: [
              { nextActionOrOnChainStateOrResultLastChangedAt: { gt: since } },
              {
                nextActionOrOnChainStateOrResultLastChangedAt: since,
                id: { gte: sinceId },
              },
            ],
          }
        : {
            ...base,
            nextActionOrOnChainStateOrResultLastChangedAt: { gte: since },
          };
    default: {
      const _never: never = mode;
      return base;
    }
  }
}

function buildPurchaseDiffOrderBy(
  mode: PurchaseDiffMode,
): Prisma.PurchaseRequestOrderByWithRelationInput[] {
  switch (mode) {
    case 'nextActionLastChangedAt':
      return [{ nextActionLastChangedAt: 'asc' }, { id: 'asc' }];
    case 'onChainStateOrResultLastChangedAt':
      return [{ onChainStateOrResultLastChangedAt: 'asc' }, { id: 'asc' }];
    case 'nextActionOrOnChainStateOrResultLastChangedAt':
      return [
        { nextActionOrOnChainStateOrResultLastChangedAt: 'asc' },
        { id: 'asc' },
      ];
    default: {
      const _never: never = mode;
      return [{ id: 'asc' }];
    }
  }
}

async function queryPurchaseDiffByMode({
  input,
  options,
  mode,
}: {
  input: z.infer<typeof queryPurchaseDiffSchemaInput>;
  options: {
    id: string;
    permission: $Enums.Permission;
    networkLimit: $Enums.Network[];
    usageLimited: boolean;
  };
  mode: PurchaseDiffMode;
}) {
  await checkIsAllowedNetworkOrThrowUnauthorized(
    options.networkLimit,
    input.network,
    options.permission,
  );

  const since = input.lastUpdate;
  const sinceId = input.cursorId;

  const result = await prisma.purchaseRequest.findMany({
    where: buildPurchaseDiffWhere({
      mode,
      since,
      sinceId,
      network: input.network,
      filterSmartContractAddress: input.filterSmartContractAddress,
    }),
    orderBy: buildPurchaseDiffOrderBy(mode),
    take: input.limit,
    include: {
      NextAction: {
        select: {
          id: true,
          requestedAction: true,
          errorType: true,
          errorNote: true,
        },
      },
      CurrentTransaction: {
        select: {
          id: true,
          createdAt: true,
          updatedAt: true,
          txHash: true,
          status: true,
          fees: true,
          blockHeight: true,
          blockTime: true,
          previousOnChainState: true,
          newOnChainState: true,
          confirmations: true,
        },
      },
      PaidFunds: { select: { id: true, amount: true, unit: true } },
      PaymentSource: {
        select: {
          id: true,
          network: true,
          policyId: true,
          smartContractAddress: true,
        },
      },
      SellerWallet: { select: { id: true, walletVkey: true } },
      SmartContractWallet: {
        where: { deletedAt: null },
        select: { id: true, walletVkey: true, walletAddress: true },
      },
      WithdrawnForSeller: {
        select: { id: true, amount: true, unit: true },
      },
      WithdrawnForBuyer: { select: { id: true, amount: true, unit: true } },
      TransactionHistory:
        input.includeHistory == true
          ? {
              orderBy: { createdAt: 'desc' },
              select: {
                id: true,
                createdAt: true,
                updatedAt: true,
                txHash: true,
                status: true,
                fees: true,
                blockHeight: true,
                blockTime: true,
                previousOnChainState: true,
                newOnChainState: true,
                confirmations: true,
              },
            }
          : undefined,
    },
  });

  if (result == null) {
    throw createHttpError(404, 'Purchase not found');
  }

  return {
    Purchases: result.map((purchase) => {
      return {
        ...purchase,
        ...transformPurchaseGetTimestamps(purchase),
        ...transformPurchaseGetAmounts(purchase),
        totalBuyerCardanoFees:
          Number(purchase.totalBuyerCardanoFees.toString()) / 1_000_000,
        totalSellerCardanoFees:
          Number(purchase.totalSellerCardanoFees.toString()) / 1_000_000,
        agentIdentifier:
          decodeBlockchainIdentifier(purchase.blockchainIdentifier)
            ?.agentIdentifier ?? null,
        CurrentTransaction: purchase.CurrentTransaction
          ? {
              ...purchase.CurrentTransaction,
              fees: purchase.CurrentTransaction.fees?.toString() ?? null,
            }
          : null,
        TransactionHistory:
          purchase.TransactionHistory != null
            ? purchase.TransactionHistory.map((tx) => ({
                ...tx,
                fees: tx.fees?.toString() ?? null,
              }))
            : [],
      };
    }),
  };
}

export const queryPurchaseDiffCombinedGet =
  payAuthenticatedEndpointFactory.build({
    method: 'get',
    input: queryPurchaseDiffSchemaInput,
    output: queryPurchaseRequestSchemaOutput,
    handler: async ({ input, options }) =>
      queryPurchaseDiffByMode({
        input,
        options,
        mode: 'nextActionOrOnChainStateOrResultLastChangedAt',
      }),
  });

export const queryPurchaseDiffNextActionGet =
  payAuthenticatedEndpointFactory.build({
    method: 'get',
    input: queryPurchaseDiffSchemaInput,
    output: queryPurchaseRequestSchemaOutput,
    handler: async ({ input, options }) =>
      queryPurchaseDiffByMode({
        input,
        options,
        mode: 'nextActionLastChangedAt',
      }),
  });

export const queryPurchaseDiffOnChainStateOrResultGet =
  payAuthenticatedEndpointFactory.build({
    method: 'get',
    input: queryPurchaseDiffSchemaInput,
    output: queryPurchaseRequestSchemaOutput,
    handler: async ({ input, options }) =>
      queryPurchaseDiffByMode({
        input,
        options,
        mode: 'onChainStateOrResultLastChangedAt',
      }),
  });
