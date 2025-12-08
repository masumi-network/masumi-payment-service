import { prisma } from '@/utils/db';
import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import { $Enums, Network } from '@prisma/client';
import { z } from 'zod';
import { splitWalletsByType } from '@/utils/shared/transformers';

export const paymentSourceSchemaInput = z.object({
  take: z
    .number({ coerce: true })
    .min(1)
    .max(100)
    .default(10)
    .describe('The number of payment sources to return'),
  cursorId: z
    .string()
    .max(250)
    .optional()
    .describe('Used to paginate through the payment sources'),
});
export const paymentSourceSchemaOutput = z.object({
  PaymentSources: z.array(
    z.object({
      id: z.string(),
      createdAt: z.date(),
      updatedAt: z.date(),
      network: z.nativeEnum(Network),
      policyId: z.string().nullable(),
      smartContractAddress: z.string(),
      lastIdentifierChecked: z.string().nullable(),
      lastCheckedAt: z.date().nullable(),
      AdminWallets: z.array(
        z.object({
          walletAddress: z.string(),
          order: z.number(),
        }),
      ),
      PurchasingWallets: z.array(
        z.object({
          id: z.string(),
          walletVkey: z.string(),
          walletAddress: z.string(),
          collectionAddress: z.string().nullable(),
          note: z.string().nullable(),
        }),
      ),
      SellingWallets: z.array(
        z.object({
          id: z.string(),
          walletVkey: z.string(),
          walletAddress: z.string(),
          collectionAddress: z.string().nullable(),
          note: z.string().nullable(),
        }),
      ),
      FeeReceiverNetworkWallet: z.object({
        walletAddress: z.string(),
      }),
      feeRatePermille: z.number().min(0).max(1000),
    }),
  ),
});

export const paymentSourceEndpointGet = readAuthenticatedEndpointFactory.build({
  method: 'get',
  input: paymentSourceSchemaInput,
  output: paymentSourceSchemaOutput,
  handler: async ({
    input,
    options,
  }: {
    input: z.infer<typeof paymentSourceSchemaInput>;
    options: {
      id: string;
      permission: $Enums.Permission;
      networkLimit: $Enums.Network[];
      usageLimited: boolean;
    };
  }) => {
    const paymentSources = await prisma.paymentSource.findMany({
      take: input.take,
      orderBy: {
        createdAt: 'desc',
      },
      cursor: input.cursorId ? { id: input.cursorId } : undefined,
      where: {
        network: { in: options.networkLimit },
        deletedAt: null,
      },
      include: {
        AdminWallets: { orderBy: { order: 'asc' } },
        HotWallets: { where: { deletedAt: null } },
        FeeReceiverNetworkWallet: true,
      },
    });
    const mappedPaymentSources = paymentSources.map((paymentSource) => {
      const { HotWallets, ...rest } = paymentSource;
      return {
        ...rest,
        ...splitWalletsByType(HotWallets),
      };
    });
    return { PaymentSources: mappedPaymentSources };
  },
});
