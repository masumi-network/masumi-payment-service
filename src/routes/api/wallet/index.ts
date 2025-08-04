import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { z } from 'zod';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { decrypt } from '@/utils/security/encryption';
import { $Enums, HotWalletType, Network } from '@prisma/client';
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

export const getWalletSchemaOutput = z.object({
  Secret: z
    .object({
      createdAt: z.date(),
      updatedAt: z.date(),
      mnemonic: z.string(),
    })
    .optional(),
  PendingTransaction: z
    .object({
      createdAt: z.date(),
      updatedAt: z.date(),
      hash: z.string().nullable(),
      lastCheckedAt: z.date().nullable(),
    })
    .nullable(),
  note: z.string().nullable(),
  walletVkey: z.string(),
  walletAddress: z.string(),
});

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
            Secret: true,
            PendingTransaction: true,
            PaymentSource: true,
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
            Secret: true,
            PendingTransaction: true,
            PaymentSource: true,
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

export const postWalletSchemaOutput = z.object({
  walletMnemonic: z.string(),
  walletAddress: z.string(),
  walletVkey: z.string(),
});

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
