import { z } from '@/utils/zod-openapi';
import { prisma } from '@/utils/db';
import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import { Network, Prisma } from '@prisma/client';
import {
  AuthContext,
  checkIsAllowedNetworkOrThrowUnauthorized,
} from '@/utils/middleware/auth-middleware';
import createHttpError from 'http-errors';
import { queryPaymentsSchemaOutput } from '@/routes/api/payments';
import {
  transformPaymentGetAmounts,
  transformPaymentGetTimestamps,
} from '@/utils/shared/transformers';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';
import { ez } from 'express-zod-api';

const paymentDiffLastUpdateSchema = ez.dateIn();

type PaymentDiffMode =
  | 'nextActionLastChangedAt'
  | 'onChainStateOrResultLastChangedAt'
  | 'nextActionOrOnChainStateOrResultLastChangedAt';

export const queryPaymentDiffSchemaInput = z.object({
  limit: z.coerce
    .number()
    .min(1)
    .max(100)
    .default(10)
    .describe('The number of payments to return'),
  cursorId: z
    .string()
    .optional()
    .describe(
      'Pagination cursor (payment id). Used as tie-breaker when lastUpdate equals a payment change timestamp',
    ),
  lastUpdate: paymentDiffLastUpdateSchema
    .default(() => paymentDiffLastUpdateSchema.parse(new Date(0).toISOString()))
    .describe(
      'Return payments whose selected status timestamp changed after this ISO timestamp',
    ),
  network: z
    .nativeEnum(Network)
    .describe('The network the payments were made on'),
  filterSmartContractAddress: z
    .string()
    .optional()
    .nullable()
    .describe('The smart contract address of the payment source'),
  includeHistory: z
    .string()
    .default('false')
    .optional()
    .transform((val) => val?.toLowerCase() == 'true')
    .describe(
      'Whether to include the full transaction and status history of the payments',
    ),
});

function buildPaymentDiffWhere({
  mode,
  since,
  sinceId,
  network,
  filterSmartContractAddress,
}: {
  mode: PaymentDiffMode;
  since: Date;
  sinceId?: string;
  network: Prisma.PaymentSourceWhereInput['network'];
  filterSmartContractAddress?: string | null;
}): Prisma.PaymentRequestWhereInput {
  const base: Prisma.PaymentRequestWhereInput = {
    PaymentSource: {
      network,
      smartContractAddress: filterSmartContractAddress ?? undefined,
      deletedAt: null,
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
      // Exhaustive check
      const _never: never = mode;
      return base;
    }
  }
}

function buildPaymentDiffOrderBy(
  mode: PaymentDiffMode,
): Prisma.PaymentRequestOrderByWithRelationInput[] {
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

async function queryPaymentDiffByMode({
  input,
  ctx,
  mode,
}: {
  input: z.infer<typeof queryPaymentDiffSchemaInput>;
  ctx: AuthContext;
  mode: PaymentDiffMode;
}) {
  await checkIsAllowedNetworkOrThrowUnauthorized(
    ctx.networkLimit,
    input.network,
    ctx.permission,
  );

  const since = input.lastUpdate;
  const sinceId = input.cursorId;

  const result = await prisma.paymentRequest.findMany({
    where: buildPaymentDiffWhere({
      mode,
      since,
      sinceId,
      network: input.network,
      filterSmartContractAddress: input.filterSmartContractAddress,
    }),
    orderBy: buildPaymentDiffOrderBy(mode),
    take: input.limit,
    include: {
      BuyerWallet: { select: { id: true, walletVkey: true } },
      SmartContractWallet: {
        where: { deletedAt: null },
        select: { id: true, walletVkey: true, walletAddress: true },
      },
      RequestedFunds: { select: { id: true, amount: true, unit: true } },
      NextAction: {
        select: {
          id: true,
          requestedAction: true,
          errorType: true,
          errorNote: true,
          resultHash: true,
        },
      },
      PaymentSource: {
        select: {
          id: true,
          network: true,
          smartContractAddress: true,
          policyId: true,
        },
      },
      CurrentTransaction: {
        select: {
          id: true,
          createdAt: true,
          updatedAt: true,
          fees: true,
          blockHeight: true,
          blockTime: true,
          txHash: true,
          status: true,
          previousOnChainState: true,
          newOnChainState: true,
          confirmations: true,
        },
      },
      WithdrawnForSeller: {
        select: { id: true, amount: true, unit: true },
      },
      WithdrawnForBuyer: {
        select: { id: true, amount: true, unit: true },
      },
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
    throw createHttpError(404, 'Payment not found');
  }

  return {
    Payments: result.map((payment) => {
      return {
        ...payment,
        ...transformPaymentGetTimestamps(payment),
        ...transformPaymentGetAmounts(payment),
        totalBuyerCardanoFees:
          Number(payment.totalBuyerCardanoFees.toString()) / 1_000_000,
        totalSellerCardanoFees:
          Number(payment.totalSellerCardanoFees.toString()) / 1_000_000,
        agentIdentifier:
          decodeBlockchainIdentifier(payment.blockchainIdentifier)
            ?.agentIdentifier ?? null,
        CurrentTransaction: payment.CurrentTransaction
          ? {
              ...payment.CurrentTransaction,
              fees: payment.CurrentTransaction.fees?.toString() ?? null,
            }
          : null,
        TransactionHistory: payment.TransactionHistory
          ? payment.TransactionHistory.map((tx) => ({
              ...tx,
              fees: tx.fees?.toString() ?? null,
            }))
          : null,
      };
    }),
  };
}

export const queryPaymentDiffCombinedGet =
  readAuthenticatedEndpointFactory.build({
    method: 'get',
    input: queryPaymentDiffSchemaInput,
    output: queryPaymentsSchemaOutput,
    handler: async ({ input, ctx }) =>
      queryPaymentDiffByMode({
        input,
        ctx,
        mode: 'nextActionOrOnChainStateOrResultLastChangedAt',
      }),
  });

export const queryPaymentDiffNextActionGet =
  readAuthenticatedEndpointFactory.build({
    method: 'get',
    input: queryPaymentDiffSchemaInput,
    output: queryPaymentsSchemaOutput,
    handler: async ({ input, ctx }) =>
      queryPaymentDiffByMode({
        input,
        ctx,
        mode: 'nextActionLastChangedAt',
      }),
  });

export const queryPaymentDiffOnChainStateOrResultGet =
  readAuthenticatedEndpointFactory.build({
    method: 'get',
    input: queryPaymentDiffSchemaInput,
    output: queryPaymentsSchemaOutput,
    handler: async ({ input, ctx }) =>
      await queryPaymentDiffByMode({
        input,
        ctx,
        mode: 'onChainStateOrResultLastChangedAt',
      }),
  });
