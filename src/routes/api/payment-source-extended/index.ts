import {
  getPaymentScriptV1,
  getRegistryScriptV1,
} from '@/utils/generator/contract-generator';
import { prisma } from '@/utils/db';
import { encrypt } from '@/utils/security/encryption';
import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { resolvePaymentKeyHash } from '@meshsdk/core-cst';
import { HotWalletType, RPCProvider, Network, $Enums } from '@prisma/client';
import createHttpError from 'http-errors';
import { z } from 'zod';
import { generateOfflineWallet } from '@/utils/generator/wallet-generator';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { DEFAULTS } from '@/utils/config';
import { splitWalletsByType } from '../../../utils/shared/transformers';

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
export const paymentSourceExtendedSchemaOutput = z.object({
  ExtendedPaymentSources: z.array(
    z.object({
      id: z.string(),
      createdAt: z.date(),
      updatedAt: z.date(),
      network: z.nativeEnum(Network),
      policyId: z.string().nullable(),
      smartContractAddress: z.string(),
      PaymentSourceConfig: z.object({
        rpcProviderApiKey: z.string(),
        rpcProvider: z.nativeEnum(RPCProvider),
      }),
      lastIdentifierChecked: z.string().nullable(),
      syncInProgress: z.boolean(),
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
          AdminWallets: { orderBy: { order: 'asc' } },
          HotWallets: { where: { deletedAt: null } },
          FeeReceiverNetworkWallet: true,
          PaymentSourceConfig: true,
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
        walletAddress: z.string().max(250),
      }),
    )
    .min(3)
    .max(3)
    .describe('The wallet addresses of the admin wallets (exactly 3)'),
  FeeReceiverNetworkWallet: z
    .object({
      walletAddress: z.string().max(250),
    })
    .describe('The wallet address of the network fee receiver wallet'),
  PurchasingWallets: z
    .array(
      z.object({
        walletMnemonic: z.string().max(1500),
        collectionAddress: z
          .string()
          .max(250)
          .nullable()
          .describe('The collection address of the purchasing wallet'),
        note: z.string().max(250),
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
        walletMnemonic: z.string().max(1500),
        collectionAddress: z
          .string()
          .max(250)
          .nullable()
          .describe('The collection address of the selling wallet'),
        note: z.string().max(250),
      }),
    )
    .min(1)
    .max(50)
    .describe(
      'The mnemonic of the selling wallets to be added. Please backup the mnemonic of the wallets.',
    ),
});
export const paymentSourceExtendedCreateSchemaOutput = z.object({
  id: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
  network: z.nativeEnum(Network),
  smartContractAddress: z.string(),
  PaymentSourceConfig: z.object({
    rpcProviderApiKey: z.string(),
    rpcProvider: z.nativeEnum(RPCProvider),
  }),
  lastIdentifierChecked: z.string().nullable(),
  syncInProgress: z.boolean(),
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
});

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
            HotWallets: { where: { deletedAt: null } },
            PaymentSourceConfig: true,
            AdminWallets: true,
            FeeReceiverNetworkWallet: true,
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
        walletMnemonic: z.string().max(1500),
        note: z.string().max(250),
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
        walletMnemonic: z.string().max(1500),
        note: z.string().max(250),
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
        id: z.string(),
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
        id: z.string(),
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
export const paymentSourceExtendedUpdateSchemaOutput = z.object({
  id: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
  network: z.nativeEnum(Network),
  smartContractAddress: z.string(),
  PaymentSourceConfig: z.object({
    rpcProviderApiKey: z.string(),
    rpcProvider: z.nativeEnum(RPCProvider),
  }),
  lastIdentifierChecked: z.string().nullable(),
  syncInProgress: z.boolean(),
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
});

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
        include: {
          HotWallets: { where: { deletedAt: null } },
          PaymentSourceConfig: true,
          AdminWallets: true,
          FeeReceiverNetworkWallet: true,
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
            HotWallets: { where: { deletedAt: null } },
            PaymentSourceConfig: true,
            AdminWallets: true,
            FeeReceiverNetworkWallet: true,
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
export const paymentSourceExtendedDeleteSchemaOutput = z.object({
  id: z.string(),
});

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
      return await prisma.paymentSource.update({
        where: { id: input.id, network: { in: options.networkLimit } },
        data: { deletedAt: new Date() },
      });
    },
  });
