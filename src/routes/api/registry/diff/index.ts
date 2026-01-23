import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { z } from '@/utils/zod-openapi';
import { ez } from 'express-zod-api';
import { prisma } from '@/utils/db';
import { Network, Prisma, PricingType } from '@/generated/prisma/client';
import {
  AuthContext,
  checkIsAllowedNetworkOrThrowUnauthorized,
} from '@/utils/middleware/auth-middleware';
import createHttpError from 'http-errors';
import { queryRegistryRequestSchemaOutput } from '@/routes/api/registry';

const registryDiffLastUpdateSchema = ez.dateIn();

export const queryRegistryDiffSchemaInput = z.object({
  limit: z.coerce
    .number()
    .min(1)
    .max(100)
    .default(10)
    .describe('The number of registry entries to return'),
  cursorId: z
    .string()
    .optional()
    .describe(
      'Pagination cursor (registry request id). Used as tie-breaker when lastUpdate equals a state-change timestamp',
    ),
  lastUpdate: registryDiffLastUpdateSchema
    .default(() => registryDiffLastUpdateSchema.parse(new Date(0).toISOString()))
    .describe(
      'Return registry entries whose registration state changed at/after this ISO timestamp',
    ),
  network: z.nativeEnum(Network).describe('The Cardano network used to register the agent on'),
  filterSmartContractAddress: z
    .string()
    .optional()
    .nullable()
    .describe('The smart contract address of the payment source'),
});

function buildRegistryDiffWhere({
  lastUpdate,
  cursorId,
  network,
  filterSmartContractAddress,
}: {
  lastUpdate: Date;
  cursorId?: string;
  network: Prisma.PaymentSourceWhereInput['network'];
  filterSmartContractAddress?: string | null;
}): Prisma.RegistryRequestWhereInput {
  const base: Prisma.RegistryRequestWhereInput = {
    PaymentSource: {
      network,
      deletedAt: null,
      smartContractAddress: filterSmartContractAddress ?? undefined,
    },
    SmartContractWallet: { deletedAt: null },
  };

  return cursorId != null
    ? {
        ...base,
        OR: [
          { registrationStateLastChangedAt: { gt: lastUpdate } },
          { registrationStateLastChangedAt: lastUpdate, id: { gte: cursorId } },
        ],
      }
    : { ...base, registrationStateLastChangedAt: { gte: lastUpdate } };
}

export const queryRegistryDiffGet = payAuthenticatedEndpointFactory.build({
  method: 'get',
  input: queryRegistryDiffSchemaInput,
  output: queryRegistryRequestSchemaOutput,
  handler: async ({
    input,
    ctx,
  }: {
    input: z.infer<typeof queryRegistryDiffSchemaInput>;
    ctx: AuthContext;
  }) => {
    await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network, ctx.permission);

    const result = await prisma.registryRequest.findMany({
      where: buildRegistryDiffWhere({
        lastUpdate: input.lastUpdate,
        cursorId: input.cursorId,
        network: input.network,
        filterSmartContractAddress: input.filterSmartContractAddress,
      }),
      orderBy: [{ registrationStateLastChangedAt: 'asc' }, { id: 'asc' }],
      take: input.limit,
      include: {
        SmartContractWallet: {
          select: { walletVkey: true, walletAddress: true },
        },
        CurrentTransaction: {
          select: {
            txHash: true,
            status: true,
            confirmations: true,
            fees: true,
            blockHeight: true,
            blockTime: true,
          },
        },
        Pricing: {
          include: {
            FixedPricing: {
              include: { Amounts: { select: { unit: true, amount: true } } },
            },
          },
        },
        ExampleOutputs: {
          select: {
            name: true,
            url: true,
            mimeType: true,
          },
        },
      },
    });

    if (result == null) {
      throw createHttpError(404, 'Registry entry not found');
    }

    return {
      Assets: result.map((item) => ({
        ...item,
        Capability: {
          name: item.capabilityName,
          version: item.capabilityVersion,
        },
        Author: {
          name: item.authorName,
          contactEmail: item.authorContactEmail,
          contactOther: item.authorContactOther,
          organization: item.authorOrganization,
        },
        Legal: {
          privacyPolicy: item.privacyPolicy,
          terms: item.terms,
          other: item.other,
        },
        AgentPricing:
          item.Pricing.pricingType == PricingType.Fixed
            ? {
                pricingType: PricingType.Fixed,
                Pricing:
                  item.Pricing.FixedPricing?.Amounts.map((price) => ({
                    unit: price.unit,
                    amount: price.amount.toString(),
                  })) ?? [],
              }
            : {
                pricingType: PricingType.Free,
              },
        Tags: item.tags,
        CurrentTransaction: item.CurrentTransaction
          ? {
              ...item.CurrentTransaction,
              fees: item.CurrentTransaction.fees?.toString() ?? null,
            }
          : null,
      })),
    };
  },
});
