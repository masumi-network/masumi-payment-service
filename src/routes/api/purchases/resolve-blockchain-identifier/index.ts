import { z } from '@/utils/zod-openapi';
import { Network, $Enums, Prisma } from '@prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { WalletAccess } from '@/services/wallet-access';
import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import {
  transformPurchaseGetTimestamps,
  transformPurchaseGetAmounts,
} from '@/utils/shared/transformers';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';
import { purchaseResponseSchema } from '@/routes/api/purchases';

export const postPurchaseRequestSchemaInput = z.object({
  blockchainIdentifier: z
    .string()
    .describe('The blockchain identifier to resolve'),
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

export const postPurchaseRequestSchemaOutput = purchaseResponseSchema;

export const resolvePurchaseRequestPost =
  readAuthenticatedEndpointFactory.build({
    method: 'post',
    input: postPurchaseRequestSchemaInput,
    output: postPurchaseRequestSchemaOutput,
    handler: async ({
      input,
      options,
    }: {
      input: z.infer<typeof postPurchaseRequestSchemaInput>;
      options: {
        id: string;
        permission: $Enums.Permission;
        networkLimit: $Enums.Network[];
        usageLimited: boolean;
        allowedWalletIds: string[];
      };
    }) => {
      await checkIsAllowedNetworkOrThrowUnauthorized(
        options.networkLimit,
        input.network,
        options.permission,
      );

      const baseWhere: Prisma.PurchaseRequestWhereInput = {
        PaymentSource: {
          deletedAt: null,
          network: input.network,
          smartContractAddress: input.filterSmartContractAddress ?? undefined,
        },
        blockchainIdentifier: input.blockchainIdentifier,
      };

      const whereClause = WalletAccess.buildFilter(
        {
          apiKeyId: options.id,
          permission: options.permission,
          allowedWalletIds: options.allowedWalletIds,
        },
        baseWhere,
      );

      const purchase = await prisma.purchaseRequest.findFirst({
        where: whereClause,
        include: {
          SellerWallet: true,
          SmartContractWallet: { where: { deletedAt: null } },
          PaidFunds: true,
          NextAction: true,
          PaymentSource: true,
          CurrentTransaction: true,
          WithdrawnForSeller: true,
          WithdrawnForBuyer: true,
          TransactionHistory: {
            orderBy: { createdAt: 'desc' },
            take: input.includeHistory == true ? undefined : 0,
          },
        },
      });
      if (purchase == null) {
        throw createHttpError(404, 'Purchase not found');
      }

      return {
        ...purchase,
        ...transformPurchaseGetTimestamps(purchase),
        ...transformPurchaseGetAmounts(purchase),
        agentIdentifier:
          decodeBlockchainIdentifier(purchase.blockchainIdentifier)
            ?.agentIdentifier ?? null,
        CurrentTransaction: purchase.CurrentTransaction
          ? {
              ...purchase.CurrentTransaction,
              fees: purchase.CurrentTransaction.fees?.toString() ?? null,
            }
          : null,
        TransactionHistory: purchase.TransactionHistory.map((tx) => ({
          ...tx,
          fees: tx.fees?.toString() ?? null,
        })),
      };
    },
  });
