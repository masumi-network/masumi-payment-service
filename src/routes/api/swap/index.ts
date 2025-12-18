import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { z } from 'zod';
import { $Enums } from '@prisma/client';
import createHttpError from 'http-errors';
import { swapTokens, Token } from '@/services/swap';
import { recordBusinessEndpointError } from '@/utils/metrics';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { Network } from '@prisma/client';
import { prisma } from '@/utils/db';
import { decrypt } from '@/utils/security/encryption';

export const swapTokensSchemaInput = z.object({
  walletVkey: z
    .string()
    .min(1)
    .describe('Wallet verification key (vKey) to identify the wallet'),
  amount: z
    .number()
    .positive()
    .describe('Amount to swap (in ADA or token units)'),
  fromToken: z
    .object({
      policyId: z
        .string()
        .describe(
          'Policy ID of the source token. Use empty string "" for ADA (native token)',
        ),
      assetName: z
        .string()
        .describe(
          'Asset name of the source token. Use empty string "" for ADA',
        ),
      name: z.string().describe('Name of the source token'),
    })
    .describe('Source token information'),
  toToken: z
    .object({
      policyId: z
        .string()
        .describe(
          'Policy ID of the destination token. Use empty string "" for ADA (native token)',
        ),
      assetName: z
        .string()
        .describe(
          'Asset name of the destination token. Use empty string "" for ADA',
        ),
      name: z.string().describe('Name of the destination token'),
    })
    .describe('Destination token information'),
  poolId: z.string().describe('SundaeSwap pool identifier'),
  slippage: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe('Slippage tolerance (0-1, default: 0.03 for 3%)'),
});

export const swapTokensSchemaOutput = z.object({
  txHash: z.string().describe('Transaction hash of the swap'),
  walletAddress: z.string().describe('Wallet address used for the swap'),
});

export const swapTokensEndpointPost = adminAuthenticatedEndpointFactory.build({
  method: 'post',
  input: swapTokensSchemaInput,
  output: swapTokensSchemaOutput,
  handler: async ({
    input,
    options,
  }: {
    input: z.infer<typeof swapTokensSchemaInput>;
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
        Network.Mainnet,
        options.permission,
      );

      const wallet = await prisma.hotWallet.findUnique({
        where: {
          walletVkey: input.walletVkey,
        },
        include: {
          Secret: true,
          PaymentSource: {
            include: {
              PaymentSourceConfig: true,
            },
          },
        },
      });

      if (wallet == null) {
        throw createHttpError(404, 'Wallet not found');
      }

      if (wallet.deletedAt != null) {
        throw createHttpError(404, 'Wallet has been deleted');
      }

      if (wallet.PaymentSource.network !== Network.Mainnet) {
        throw createHttpError(
          400,
          'Swap functionality is only available for mainnet wallets',
        );
      }

      if (!wallet.PaymentSource.PaymentSourceConfig) {
        throw createHttpError(400, 'Payment source configuration not found');
      }

      const blockfrostApiKey =
        wallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey;

      if (!blockfrostApiKey) {
        throw createHttpError(
          400,
          'Blockfrost API key not found in payment source configuration',
        );
      }

      const mnemonic = decrypt(wallet.Secret.encryptedMnemonic);

      const result = await swapTokens(
        {
          mnemonic: mnemonic,
          fromAmount: input.amount,
          fromToken: input.fromToken as Token,
          toToken: input.toToken as Token,
          poolId: input.poolId,
          slippage: input.slippage,
        },
        blockfrostApiKey,
      );

      return result;
    } catch (error) {
      const errorInstance =
        error instanceof Error ? error : new Error(String(error));
      const statusCode =
        (errorInstance as { statusCode?: number; status?: number })
          .statusCode ||
        (errorInstance as { statusCode?: number; status?: number }).status ||
        500;
      recordBusinessEndpointError(
        '/api/v1/swap',
        'POST',
        statusCode,
        errorInstance,
        {
          user_id: options.id,
          operation: 'swap_tokens',
          duration: Date.now() - startTime,
        },
      );
      throw error;
    }
  },
});
