import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { z } from '@/utils/zod-openapi';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { decrypt } from '@/utils/security/encryption';
import { $Enums, HotWalletType, Network } from '@/generated/prisma/client';
import { MeshWallet, resolvePaymentKeyHash } from '@meshsdk/core';
import { generateOfflineWallet } from '@/utils/generator/wallet-generator';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { recordBusinessEndpointError } from '@/utils/metrics';

export const getWalletSchemaInput = z.object({
  walletType: z
    .enum(['Selling', 'Purchasing'])
    .describe('The type of wallet to query'),
  id: z.string().min(1).max(250).describe('The id of the wallet to query'),
  includeSecret: z
    .string()
    .transform((s) => (s.toLowerCase() == 'true' ? true : false))
    .default('false')
    .describe('Whether to include the decrypted secret in the response'),
});

export const getWalletSchemaOutput = z
  .object({
    Secret: z
      .object({
        createdAt: z.date().describe('Timestamp when the secret was created'),
        updatedAt: z
          .date()
          .describe('Timestamp when the secret was last updated'),
        mnemonic: z
          .string()
          .describe('Decrypted 24-word mnemonic phrase for the wallet'),
      })
      .optional()
      .describe(
        'Wallet secret (mnemonic). Only included if includeSecret is true',
      ),
    PendingTransaction: z
      .object({
        createdAt: z
          .date()
          .describe('Timestamp when the pending transaction was created'),
        updatedAt: z
          .date()
          .describe('Timestamp when the pending transaction was last updated'),
        hash: z
          .string()
          .nullable()
          .describe(
            'Transaction hash of the pending transaction. Null if not yet submitted',
          ),
        lastCheckedAt: z
          .date()
          .nullable()
          .describe(
            'Timestamp when the pending transaction was last checked. Null if never checked',
          ),
      })
      .nullable()
      .describe(
        'Pending transaction for this wallet. Null if no transaction is pending',
      ),
    note: z
      .string()
      .nullable()
      .describe('Optional note about this wallet. Null if not set'),
    walletVkey: z.string().describe('Payment key hash of the wallet'),
    walletAddress: z.string().describe('Cardano address of the wallet'),
    collectionAddress: z
      .string()
      .nullable()
      .describe('Collection address for this wallet. Null if not set'),
  })
  .openapi('Wallet');

export const queryWalletEndpointGet = adminAuthenticatedEndpointFactory.build({
  method: 'get',
  input: getWalletSchemaInput,
  output: getWalletSchemaOutput,
  handler: async ({
    input,
    options,
  }: {
    input: z.infer<typeof getWalletSchemaInput>;
    options: {
      id: string;
      permission: $Enums.Permission;
      networkLimit: $Enums.Network[];
      usageLimited: boolean;
    };
  }) => {
    const startTime = Date.now();
    try {
      if (input.walletType == 'Selling') {
        const result = await prisma.hotWallet.findFirst({
          where: {
            id: input.id,
            type: HotWalletType.Selling,
            PaymentSource: {
              network: { in: options.networkLimit },
            },
            deletedAt: null,
          },
          include: {
            Secret: {
              select: {
                encryptedMnemonic: true,
                createdAt: true,
                updatedAt: true,
              },
            },
            PendingTransaction: {
              select: {
                createdAt: true,
                updatedAt: true,
                txHash: true,
                lastCheckedAt: true,
              },
            },
          },
        });
        if (result == null) {
          recordBusinessEndpointError(
            '/api/v1/wallet',
            'GET',
            404,
            'Selling wallet not found',
            {
              wallet_id: input.id,
              wallet_type: 'selling',
              operation: 'wallet_lookup',
            },
          );
          throw createHttpError(404, 'Selling wallet not found');
        }

        // Success is automatically recorded by middleware

        if (input.includeSecret == true) {
          const decodedMnemonic = decrypt(result.Secret.encryptedMnemonic);
          return {
            PendingTransaction: result.PendingTransaction
              ? {
                  createdAt: result.PendingTransaction.createdAt,
                  updatedAt: result.PendingTransaction.updatedAt,
                  hash: result.PendingTransaction.txHash,
                  lastCheckedAt: result.PendingTransaction.lastCheckedAt,
                }
              : null,
            note: result.note,
            walletVkey: result.walletVkey,
            walletAddress: result.walletAddress,
            collectionAddress: result.collectionAddress,
            Secret: {
              createdAt: result.Secret.createdAt,
              updatedAt: result.Secret.updatedAt,
              mnemonic: decodedMnemonic,
            },
          };
        }
        return {
          PendingTransaction: result.PendingTransaction
            ? {
                createdAt: result.PendingTransaction.createdAt,
                updatedAt: result.PendingTransaction.updatedAt,
                hash: result.PendingTransaction.txHash,
                lastCheckedAt: result.PendingTransaction.lastCheckedAt,
              }
            : null,
          note: result.note,
          collectionAddress: result.collectionAddress,
          walletVkey: result.walletVkey,
          walletAddress: result.walletAddress,
        };
      } else if (input.walletType == 'Purchasing') {
        const result = await prisma.hotWallet.findFirst({
          where: {
            id: input.id,
            type: HotWalletType.Purchasing,
            PaymentSource: {
              network: { in: options.networkLimit },
            },
            deletedAt: null,
          },
          include: {
            Secret: {
              select: {
                encryptedMnemonic: true,
                createdAt: true,
                updatedAt: true,
              },
            },
            PendingTransaction: {
              select: {
                createdAt: true,
                updatedAt: true,
                txHash: true,
                lastCheckedAt: true,
              },
            },
          },
        });
        if (result == null) {
          throw createHttpError(404, 'Purchasing wallet not found');
        }

        // Success is automatically recorded by middleware

        if (input.includeSecret == true) {
          const decodedMnemonic = decrypt(result.Secret.encryptedMnemonic);
          return {
            PendingTransaction: result.PendingTransaction
              ? {
                  createdAt: result.PendingTransaction.createdAt,
                  updatedAt: result.PendingTransaction.updatedAt,
                  hash: result.PendingTransaction.txHash,
                  lastCheckedAt: result.PendingTransaction.lastCheckedAt,
                }
              : null,
            note: result.note,
            walletVkey: result.walletVkey,
            walletAddress: result.walletAddress,
            collectionAddress: result.collectionAddress,
            Secret: {
              createdAt: result.Secret.createdAt,
              updatedAt: result.Secret.updatedAt,
              mnemonic: decodedMnemonic,
            },
          };
        }
        return {
          PendingTransaction: result.PendingTransaction
            ? {
                createdAt: result.PendingTransaction.createdAt,
                updatedAt: result.PendingTransaction.updatedAt,
                hash: result.PendingTransaction.txHash,
                lastCheckedAt: result.PendingTransaction.lastCheckedAt,
              }
            : null,
          note: result.note,
          walletVkey: result.walletVkey,
          collectionAddress: result.collectionAddress,
          walletAddress: result.walletAddress,
        };
      }
      throw createHttpError(400, 'Invalid wallet type');
    } catch (error) {
      const errorInstance =
        error instanceof Error ? error : new Error(String(error));
      const statusCode =
        (errorInstance as { statusCode?: number; status?: number })
          .statusCode ||
        (errorInstance as { statusCode?: number; status?: number }).status ||
        500;
      recordBusinessEndpointError(
        '/api/v1/wallet',
        'GET',
        statusCode,
        errorInstance,
        {
          user_id: options.id,
          wallet_id: input.id,
          wallet_type: input.walletType.toLowerCase(),
          operation: 'query_wallet',
          duration: Date.now() - startTime,
        },
      );
      throw error;
    }
  },
});

export const postWalletSchemaInput = z.object({
  network: z
    .nativeEnum(Network)
    .describe('The network the Cardano wallet will be used on'),
});

export const postWalletSchemaOutput = z
  .object({
    walletMnemonic: z
      .string()
      .describe(
        '24-word mnemonic phrase for the newly generated wallet. IMPORTANT: Backup this mnemonic securely',
      ),
    walletAddress: z
      .string()
      .describe('Cardano address of the newly generated wallet'),
    walletVkey: z
      .string()
      .describe('Payment key hash of the newly generated wallet'),
  })
  .openapi('GeneratedWalletSecret');

export const postWalletEndpointPost = adminAuthenticatedEndpointFactory.build({
  method: 'post',
  input: postWalletSchemaInput,
  output: postWalletSchemaOutput,
  handler: async ({
    input,
    options,
  }: {
    input: z.infer<typeof postWalletSchemaInput>;
    options: {
      id: string;
      permission: $Enums.Permission;
      networkLimit: $Enums.Network[];
      usageLimited: boolean;
    };
  }) => {
    const startTime = Date.now();
    try {
      await checkIsAllowedNetworkOrThrowUnauthorized(
        options.networkLimit,
        input.network,
        options.permission,
      );
      const secretKey = MeshWallet.brew(false);
      const secretWords =
        typeof secretKey == 'string' ? secretKey.split(' ') : secretKey;

      const wallet = generateOfflineWallet(input.network, secretWords);

      const address = (await wallet.getUnusedAddresses())[0];
      const vKey = resolvePaymentKeyHash(address);

      // Success is automatically recorded by middleware

      return {
        walletMnemonic: secretWords.join(' '),
        walletAddress: address,
        walletVkey: vKey,
      };
    } catch (error) {
      const errorInstance =
        error instanceof Error ? error : new Error(String(error));
      const statusCode =
        (errorInstance as { statusCode?: number; status?: number })
          .statusCode ||
        (errorInstance as { statusCode?: number; status?: number }).status ||
        500;
      recordBusinessEndpointError(
        '/api/v1/wallet',
        'POST',
        statusCode,
        errorInstance,
        {
          user_id: options.id,
          network: input.network,
          operation: 'create_wallet',
          duration: Date.now() - startTime,
        },
      );
      throw error;
    }
  },
});

export const patchWalletSchemaInput = z.object({
  id: z.string().min(1).max(250).describe('The id of the wallet to update'),
  newCollectionAddress: z
    .string()
    .max(250)
    .nullable()
    .describe(
      'The new collection address to set for this wallet. Pass null to clear.',
    ),
});

export const patchWalletSchemaOutput = getWalletSchemaOutput;

export const patchWalletEndpointPatch = adminAuthenticatedEndpointFactory.build(
  {
    method: 'patch',
    input: patchWalletSchemaInput,
    output: patchWalletSchemaOutput,
    handler: async ({
      input,
    }: {
      input: z.infer<typeof patchWalletSchemaInput>;
    }) => {
      const wallet = await prisma.hotWallet.findFirst({
        where: {
          id: input.id,
          deletedAt: null,
        },
      });

      if (wallet == null) {
        throw createHttpError(404, `${input.id} wallet not found`);
      }

      const result = await prisma.hotWallet.update({
        where: { id: wallet.id },
        data: { collectionAddress: input.newCollectionAddress },
        include: {
          Secret: false,
          PendingTransaction: {
            select: {
              createdAt: true,
              updatedAt: true,
              txHash: true,
              lastCheckedAt: true,
            },
          },
        },
      });

      return {
        PendingTransaction: result.PendingTransaction
          ? {
              createdAt: result.PendingTransaction.createdAt,
              updatedAt: result.PendingTransaction.updatedAt,
              hash: result.PendingTransaction.txHash,
              lastCheckedAt: result.PendingTransaction.lastCheckedAt,
            }
          : null,
        note: result.note,
        walletVkey: result.walletVkey,
        walletAddress: result.walletAddress,
        collectionAddress: result.collectionAddress,
      };
    },
  },
);
