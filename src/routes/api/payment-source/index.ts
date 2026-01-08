import { prisma } from '@/utils/db';
import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import { $Enums, Network } from '@prisma/client';
import { z } from '@/utils/zod-openapi';
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

export const paymentSourceOutputSchema = z
  .object({
    id: z.string().describe('Unique identifier for the payment source'),
    createdAt: z
      .date()
      .describe('Timestamp when the payment source was created'),
    updatedAt: z
      .date()
      .describe('Timestamp when the payment source was last updated'),
    network: z
      .nativeEnum(Network)
      .describe('The Cardano network (Mainnet, Preprod, or Preview)'),
    policyId: z
      .string()
      .nullable()
      .describe(
        'Policy ID for the agent registry NFTs. Null if not applicable',
      ),
    smartContractAddress: z
      .string()
      .describe('Address of the smart contract for this payment source'),
    lastIdentifierChecked: z
      .string()
      .nullable()
      .describe(
        'Last agent identifier checked during registry sync. Null if not synced yet',
      ),
    lastCheckedAt: z
      .date()
      .nullable()
      .describe(
        'Timestamp when the registry was last synced. Null if never synced',
      ),
    AdminWallets: z
      .array(
        z.object({
          walletAddress: z
            .string()
            .describe('Cardano address of the admin wallet'),
          order: z.number().describe('Order/index of this admin wallet '),
        }),
      )
      .describe('List of admin wallets for dispute resolution'),
    PurchasingWallets: z
      .array(
        z.object({
          id: z
            .string()
            .describe('Unique identifier for the purchasing wallet'),
          walletVkey: z
            .string()
            .describe('Payment key hash of the purchasing wallet'),
          walletAddress: z
            .string()
            .describe('Cardano address of the purchasing wallet'),
          collectionAddress: z
            .string()
            .nullable()
            .describe(
              'Optional collection address for this wallet. Null if not set',
            ),
          note: z
            .string()
            .nullable()
            .describe('Optional note about this wallet. Null if not set'),
        }),
      )
      .describe('List of wallets used for purchasing (buyer side)'),
    SellingWallets: z
      .array(
        z.object({
          id: z.string().describe('Unique identifier for the selling wallet'),
          walletVkey: z
            .string()
            .describe('Payment key hash of the selling wallet'),
          walletAddress: z
            .string()
            .describe('Cardano address of the selling wallet'),
          collectionAddress: z
            .string()
            .nullable()
            .describe(
              'Optional collection address for this wallet. Null if not set',
            ),
          note: z
            .string()
            .nullable()
            .describe('Optional note about this wallet. Null if not set'),
        }),
      )
      .describe('List of wallets used for selling (seller side)'),
    FeeReceiverNetworkWallet: z
      .object({
        walletAddress: z
          .string()
          .describe('Cardano address that receives network fees'),
      })
      .describe('Wallet that receives network fees from transactions'),
    feeRatePermille: z
      .number()
      .min(0)
      .max(1000)
      .describe('Fee rate in permille'),
  })
  .openapi('PaymentSource');
export const paymentSourceSchemaOutput = z.object({
  PaymentSources: z
    .array(paymentSourceOutputSchema)
    .describe('List of payment sources'),
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
        AdminWallets: {
          orderBy: { order: 'asc' },
          select: { walletAddress: true, order: true },
        },
        HotWallets: {
          where: { deletedAt: null },
          select: {
            id: true,
            walletVkey: true,
            walletAddress: true,
            type: true,
            collectionAddress: true,
            note: true,
          },
        },
        FeeReceiverNetworkWallet: {
          select: {
            walletAddress: true,
          },
        },
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
