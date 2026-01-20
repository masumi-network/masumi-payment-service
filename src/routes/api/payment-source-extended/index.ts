import {
  getPaymentScriptV1,
  getRegistryScriptV1,
} from '@/utils/generator/contract-generator';
import { prisma } from '@/utils/db';
import { encrypt } from '@/utils/security/encryption';
import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { resolvePaymentKeyHash } from '@meshsdk/core-cst';
import { HotWalletType, RPCProvider, Network } from '@/generated/prisma/client';
import createHttpError from 'http-errors';
import { z } from '@/utils/zod-openapi';
import { generateOfflineWallet } from '@/utils/generator/wallet-generator';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { DEFAULTS } from '@/utils/config';
import { splitWalletsByType } from '@/utils/shared/transformers';

export const paymentSourceExtendedSchemaInput = z.object({
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

export const paymentSourceExtendedOutputSchema = z
  .object({
    id: z.string().describe('Unique identifier for the payment source'),
    createdAt: z
      .date()
      .describe('Timestamp when the payment source was created'),
    updatedAt: z
      .date()
      .describe('Timestamp when the payment source was last updated'),
    network: z.nativeEnum(Network).describe('The Cardano network'),
    policyId: z
      .string()
      .nullable()
      .describe(
        'Policy ID for the agent registry NFTs. Null if not applicable',
      ),
    smartContractAddress: z
      .string()
      .describe('Address of the smart contract for this payment source'),
    PaymentSourceConfig: z
      .object({
        rpcProviderApiKey: z
          .string()
          .describe('The RPC provider API key (e.g., Blockfrost project ID)'),
        rpcProvider: z
          .nativeEnum(RPCProvider)
          .describe('The RPC provider type (e.g., Blockfrost)'),
      })
      .describe('RPC provider configuration for blockchain interactions'),
    lastIdentifierChecked: z
      .string()
      .nullable()
      .describe(
        'Last agent identifier checked during registry sync. Null if not synced yet',
      ),
    syncInProgress: z
      .boolean()
      .describe('Whether a registry sync is currently in progress'),
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
          order: z.number().describe('Order/index of this admin wallet (0-2)'),
        }),
      )
      .describe(
        'List of admin wallets for dispute resolution (exactly 3 required)',
      ),
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
      .describe('Fee rate in permille (per thousand). Example: 50 = 5%'),
  })
  .openapi('PaymentSourceExtended');
export const paymentSourceExtendedSchemaOutput = z.object({
  ExtendedPaymentSources: z
    .array(paymentSourceExtendedOutputSchema)
    .describe(
      'List of payment sources with extended details including RPC configuration',
    ),
});

export const paymentSourceExtendedEndpointGet =
  adminAuthenticatedEndpointFactory.build({
    method: 'get',
    input: paymentSourceExtendedSchemaInput,
    output: paymentSourceExtendedSchemaOutput,
    handler: async ({
      input,
      options,
    }: {
      input: z.infer<typeof paymentSourceExtendedSchemaInput>;
      options: {
        id: string;
        permission: $Enums.Permission;
        networkLimit: $Enums.Network[];
        usageLimited: boolean;
      };
    }) => {
      const paymentSources = await prisma.paymentSource.findMany({
        where: {
          network: {
            in: options.networkLimit,
          },
          deletedAt: null,
        },
        take: input.take,
        orderBy: {
          createdAt: 'desc',
        },
        cursor: input.cursorId ? { id: input.cursorId } : undefined,
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
            select: { walletAddress: true },
          },
          PaymentSourceConfig: {
            select: { rpcProviderApiKey: true, rpcProvider: true },
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
      return { ExtendedPaymentSources: mappedPaymentSources };
    },
  });

export const paymentSourceExtendedCreateSchemaInput = z.object({
  network: z
    .nativeEnum(Network)
    .describe('The network the payment source will be used on'),
  PaymentSourceConfig: z.object({
    rpcProviderApiKey: z
      .string()
      .max(250)
      .describe(
        'The rpc provider (blockfrost) api key to be used for the payment source',
      ),
    rpcProvider: z
      .nativeEnum(RPCProvider)
      .describe('The rpc provider to be used for the payment source'),
  }),
  feeRatePermille: z
    .number({ coerce: true })
    .min(0)
    .max(1000)
    .describe(
      'The fee in permille to be used for the payment source. The default contract uses 50 (5%)',
    ),
  cooldownTime: z
    .number({ coerce: true })
    .min(0)
    .optional()
    .describe(
      'The cooldown time in milliseconds to be used for the payment source. The default contract uses 1000 * 60 * 7 (7 minutes)',
    ),
  AdminWallets: z
    .array(
      z.object({
        walletAddress: z
          .string()
          .max(250)
          .describe('Cardano address of the admin wallet'),
      }),
    )
    .min(3)
    .max(3)
    .describe('The wallet addresses of the admin wallets (exactly 3)'),
  FeeReceiverNetworkWallet: z
    .object({
      walletAddress: z
        .string()
        .max(250)
        .describe('Cardano address that receives network fees'),
    })
    .describe('The wallet address of the network fee receiver wallet'),
  PurchasingWallets: z
    .array(
      z.object({
        walletMnemonic: z
          .string()
          .max(1500)
          .describe(
            '24-word mnemonic phrase for the purchasing wallet. IMPORTANT: Backup this securely',
          ),
        collectionAddress: z
          .string()
          .max(250)
          .nullable()
          .describe('The collection address of the purchasing wallet'),
        note: z.string().max(250).describe('Note about this purchasing wallet'),
      }),
    )
    .min(1)
    .max(50)
    .describe(
      'The mnemonic of the purchasing wallets to be added. Please backup the mnemonic of the wallets.',
    ),
  SellingWallets: z
    .array(
      z.object({
        walletMnemonic: z
          .string()
          .max(1500)
          .describe('24-word mnemonic phrase for the selling wallet'),
        collectionAddress: z
          .string()
          .max(250)
          .nullable()
          .describe('The collection address of the selling wallet'),
        note: z.string().max(250).describe('Note about this selling wallet'),
      }),
    )
    .min(1)
    .max(50)
    .describe(
      'The mnemonic of the selling wallets to be added. Please backup the mnemonic of the wallets.',
    ),
});
export const paymentSourceExtendedCreateSchemaOutput =
  paymentSourceExtendedOutputSchema;

export const paymentSourceExtendedEndpointPost =
  adminAuthenticatedEndpointFactory.build({
    method: 'post',
    input: paymentSourceExtendedCreateSchemaInput,
    output: paymentSourceExtendedCreateSchemaOutput,
    handler: async ({
      input,
      options,
    }: {
      input: z.infer<typeof paymentSourceExtendedCreateSchemaInput>;
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
      const sellingWalletsMesh = input.SellingWallets.map((sellingWallet) => {
        return {
          wallet: generateOfflineWallet(
            input.network,
            sellingWallet.walletMnemonic.split(' '),
          ),
          note: sellingWallet.note,
          mnemonicEncrypted: encrypt(sellingWallet.walletMnemonic),
          collectionAddress: sellingWallet.collectionAddress,
        };
      });
      const purchasingWalletsMesh = input.PurchasingWallets.map(
        (purchasingWallet) => {
          return {
            wallet: generateOfflineWallet(
              input.network,
              purchasingWallet.walletMnemonic.split(' '),
            ),
            note: purchasingWallet.note,
            mnemonicEncrypted: encrypt(purchasingWallet.walletMnemonic),
            collectionAddress: purchasingWallet.collectionAddress,
          };
        },
      );

      return await prisma.$transaction(async (prisma) => {
        const { smartContractAddress } = await getPaymentScriptV1(
          input.AdminWallets[0].walletAddress,
          input.AdminWallets[1].walletAddress,
          input.AdminWallets[2].walletAddress,
          input.FeeReceiverNetworkWallet.walletAddress,
          input.feeRatePermille,
          input.cooldownTime ??
            (input.network == Network.Preprod
              ? DEFAULTS.COOLDOWN_TIME_PREPROD
              : DEFAULTS.COOLDOWN_TIME_MAINNET),
          input.network,
        );

        const { policyId } = await getRegistryScriptV1(
          smartContractAddress,
          input.network,
        );

        const sellingWallets = await Promise.all(
          sellingWalletsMesh.map(async (sw) => {
            return {
              walletAddress: (await sw.wallet.getUnusedAddresses())[0],
              walletVkey: resolvePaymentKeyHash(
                (await sw.wallet.getUnusedAddresses())[0],
              ),
              secretId: (
                await prisma.walletSecret.create({
                  data: { encryptedMnemonic: sw.mnemonicEncrypted },
                })
              ).id,
              note: sw.note,
              type: HotWalletType.Selling,
              collectionAddress: sw.collectionAddress,
            };
          }),
        );

        const purchasingWallets = await Promise.all(
          purchasingWalletsMesh.map(async (pw) => {
            return {
              walletVkey: resolvePaymentKeyHash(
                (await pw.wallet.getUnusedAddresses())[0],
              ),
              walletAddress: (await pw.wallet.getUnusedAddresses())[0],
              secretId: (
                await prisma.walletSecret.create({
                  data: { encryptedMnemonic: pw.mnemonicEncrypted },
                })
              ).id,
              note: pw.note,
              type: HotWalletType.Purchasing,
              collectionAddress: pw.collectionAddress,
            };
          }),
        );

        const paymentSource = await prisma.paymentSource.create({
          data: {
            network: input.network,
            smartContractAddress: smartContractAddress,
            policyId: policyId,
            PaymentSourceConfig: {
              create: {
                rpcProviderApiKey: input.PaymentSourceConfig.rpcProviderApiKey,
                rpcProvider: input.PaymentSourceConfig.rpcProvider,
              },
            },
            cooldownTime:
              input.cooldownTime ??
              (input.network == Network.Preprod
                ? DEFAULTS.COOLDOWN_TIME_PREPROD
                : DEFAULTS.COOLDOWN_TIME_MAINNET),
            AdminWallets: {
              createMany: {
                data: input.AdminWallets.map((aw, index) => ({
                  walletAddress: aw.walletAddress,
                  order: index,
                })),
              },
            },
            feeRatePermille: input.feeRatePermille,
            FeeReceiverNetworkWallet: {
              create: {
                walletAddress: input.FeeReceiverNetworkWallet.walletAddress,
                order: 0,
              },
            },
            HotWallets: {
              createMany: {
                data: [...purchasingWallets, ...sellingWallets],
              },
            },
          },
          include: {
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
            PaymentSourceConfig: {
              select: {
                rpcProviderApiKey: true,
                rpcProvider: true,
              },
            },
            AdminWallets: {
              select: {
                walletAddress: true,
                order: true,
              },
            },
            FeeReceiverNetworkWallet: {
              select: {
                walletAddress: true,
              },
            },
          },
        });

        const { HotWallets, ...rest } = paymentSource;
        return {
          ...rest,
          ...splitWalletsByType(HotWallets),
        };
      });
    },
  });

export const paymentSourceExtendedUpdateSchemaInput = z.object({
  id: z
    .string()
    .max(250)
    .describe('The id of the payment source to be updated'),
  PaymentSourceConfig: z
    .object({
      rpcProviderApiKey: z
        .string()
        .max(250)
        .describe(
          'The rpc provider (blockfrost) api key to be used for the payment source',
        ),
      rpcProvider: z
        .nativeEnum(RPCProvider)
        .describe('The rpc provider to be used for the payment contract'),
    })
    .optional(),
  AddPurchasingWallets: z
    .array(
      z.object({
        walletMnemonic: z
          .string()
          .max(1500)
          .describe(
            '24-word mnemonic phrase for the purchasing wallet. IMPORTANT: Backup this securely',
          ),
        note: z.string().max(250).describe('Note about this purchasing wallet'),
        collectionAddress: z
          .string()
          .max(250)
          .nullable()
          .describe('The collection address of the purchasing wallet'),
      }),
    )
    .min(1)
    .max(10)
    .optional()
    .describe('The mnemonic of the purchasing wallets to be added'),
  AddSellingWallets: z
    .array(
      z.object({
        walletMnemonic: z
          .string()
          .max(1500)
          .describe('24-word mnemonic phrase for the selling wallet'),
        note: z.string().max(250).describe('Note about this selling wallet'),
        collectionAddress: z
          .string()
          .max(250)
          .nullable()
          .describe('The collection address of the selling wallet'),
      }),
    )
    .min(1)
    .max(10)
    .optional()
    .describe('The mnemonic of the selling wallets to be added'),
  RemovePurchasingWallets: z
    .array(
      z.object({
        id: z.string().describe('ID of the purchasing wallet to remove'),
      }),
    )
    .max(10)
    .optional()
    .describe(
      'The ids of the purchasing wallets to be removed. Please backup the mnemonic of the old wallet before removing it.',
    ),
  RemoveSellingWallets: z
    .array(
      z.object({
        id: z.string().describe('ID of the selling wallet to remove'),
      }),
    )
    .max(10)
    .optional()
    .describe(
      'The ids of the selling wallets to be removed. Please backup the mnemonic of the old wallet before removing it.',
    ),
  lastIdentifierChecked: z
    .string()
    .max(250)
    .nullable()
    .optional()
    .describe(
      'The latest identifier of the payment source. Usually should not be changed',
    ),
});
export const paymentSourceExtendedUpdateSchemaOutput =
  paymentSourceExtendedOutputSchema;

export const paymentSourceExtendedEndpointPatch =
  adminAuthenticatedEndpointFactory.build({
    method: 'patch',
    input: paymentSourceExtendedUpdateSchemaInput,
    output: paymentSourceExtendedUpdateSchemaOutput,
    handler: async ({
      input,
      options,
    }: {
      input: z.infer<typeof paymentSourceExtendedUpdateSchemaInput>;
      options: {
        id: string;
        permission: $Enums.Permission;
        networkLimit: $Enums.Network[];
        usageLimited: boolean;
      };
    }) => {
      const paymentSource = await prisma.paymentSource.findUnique({
        where: {
          id: input.id,
          network: { in: options.networkLimit },
          deletedAt: null,
        },
      });
      if (paymentSource == null) {
        throw createHttpError(404, 'Payment source not found');
      }
      const sellingWalletsMesh = input.AddSellingWallets?.map(
        (sellingWallet) => {
          return {
            wallet: generateOfflineWallet(
              paymentSource.network,
              sellingWallet.walletMnemonic.split(' '),
            ),
            note: sellingWallet.note,
            mnemonicEncrypted: encrypt(sellingWallet.walletMnemonic),
            collectionAddress: sellingWallet.collectionAddress,
          };
        },
      );
      const purchasingWalletsMesh = input.AddPurchasingWallets?.map(
        (purchasingWallet) => {
          return {
            wallet: generateOfflineWallet(
              paymentSource.network,
              purchasingWallet.walletMnemonic.split(' '),
            ),
            note: purchasingWallet.note,
            mnemonicEncrypted: encrypt(purchasingWallet.walletMnemonic),
            collectionAddress: purchasingWallet.collectionAddress,
          };
        },
      );
      const result = await prisma.$transaction(async (prisma) => {
        const sellingWallets =
          sellingWalletsMesh != null
            ? await Promise.all(
                sellingWalletsMesh.map(async (sw) => {
                  return {
                    walletAddress: (await sw.wallet.getUnusedAddresses())[0],
                    walletVkey: resolvePaymentKeyHash(
                      (await sw.wallet.getUnusedAddresses())[0],
                    ),
                    secretId: (
                      await prisma.walletSecret.create({
                        data: { encryptedMnemonic: sw.mnemonicEncrypted },
                      })
                    ).id,
                    note: sw.note,
                    type: HotWalletType.Selling,
                    collectionAddress: sw.collectionAddress,
                  };
                }),
              )
            : [];

        const purchasingWallets =
          purchasingWalletsMesh != null
            ? await Promise.all(
                purchasingWalletsMesh.map(async (pw) => {
                  return {
                    walletAddress: (await pw.wallet.getUnusedAddresses())[0],
                    walletVkey: resolvePaymentKeyHash(
                      (await pw.wallet.getUnusedAddresses())[0],
                    ),
                    secretId: (
                      await prisma.walletSecret.create({
                        data: { encryptedMnemonic: pw.mnemonicEncrypted },
                      })
                    ).id,
                    note: pw.note,
                    type: HotWalletType.Purchasing,
                    collectionAddress: pw.collectionAddress,
                  };
                }),
              )
            : [];

        const walletIdsToRemove = [
          ...(input.RemoveSellingWallets ?? []),
          ...(input.RemovePurchasingWallets ?? []),
        ].map((rw) => rw.id);

        if (walletIdsToRemove.length > 0) {
          await prisma.paymentSource.update({
            where: { id: input.id },
            data: {
              HotWallets: {
                updateMany: {
                  where: { id: { in: walletIdsToRemove } },
                  data: { deletedAt: new Date() },
                },
              },
            },
          });
        }

        const paymentSource = await prisma.paymentSource.update({
          where: { id: input.id },
          data: {
            lastIdentifierChecked: input.lastIdentifierChecked,
            PaymentSourceConfig:
              input.PaymentSourceConfig != null
                ? {
                    update: {
                      rpcProviderApiKey:
                        input.PaymentSourceConfig.rpcProviderApiKey,
                    },
                  }
                : undefined,
            HotWallets: {
              createMany: {
                data: [...purchasingWallets, ...sellingWallets],
              },
            },
          },
          include: {
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
            PaymentSourceConfig: {
              select: {
                rpcProviderApiKey: true,
                rpcProvider: true,
              },
            },
            AdminWallets: {
              select: {
                walletAddress: true,
                order: true,
              },
            },
            FeeReceiverNetworkWallet: {
              select: {
                walletAddress: true,
              },
            },
          },
        });

        return paymentSource;
      });
      const { HotWallets, ...rest } = result;
      return {
        ...rest,
        ...splitWalletsByType(HotWallets),
      };
    },
  });

export const paymentSourceExtendedDeleteSchemaInput = z.object({
  id: z.string().describe('The id of the payment source to be deleted'),
});
export const paymentSourceExtendedDeleteSchemaOutput =
  paymentSourceExtendedOutputSchema;

export const paymentSourceExtendedEndpointDelete =
  adminAuthenticatedEndpointFactory.build({
    method: 'delete',
    input: paymentSourceExtendedDeleteSchemaInput,
    output: paymentSourceExtendedDeleteSchemaOutput,
    handler: async ({
      input,
      options,
    }: {
      input: z.infer<typeof paymentSourceExtendedDeleteSchemaInput>;
      options: {
        id: string;
        permission: $Enums.Permission;
        networkLimit: $Enums.Network[];
        usageLimited: boolean;
      };
    }) => {
      const paymentSource = await prisma.paymentSource.update({
        where: { id: input.id, network: { in: options.networkLimit } },
        data: { deletedAt: new Date() },
        include: {
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
          PaymentSourceConfig: {
            select: {
              rpcProviderApiKey: true,
              rpcProvider: true,
            },
          },
          AdminWallets: {
            select: {
              walletAddress: true,
              order: true,
            },
          },
          FeeReceiverNetworkWallet: {
            select: {
              walletAddress: true,
            },
          },
        },
      });
      const { HotWallets, ...rest } = paymentSource;
      return {
        ...rest,
        ...splitWalletsByType(HotWallets),
      };
    },
  });
