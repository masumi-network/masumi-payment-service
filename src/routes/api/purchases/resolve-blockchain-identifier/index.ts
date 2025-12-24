import { z } from '@/utils/zod-openapi';
import { Network, $Enums } from '@prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import {
  transformPurchaseGetTimestamps,
  transformPurchaseGetAmounts,
} from '@/utils/shared/transformers';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';
import { purchaseResponseSchema } from '@/routes/api/purchases';
import { calculateTransactionFees } from '@/utils/shared/fee-calculator';

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
      };
    }) => {
      await checkIsAllowedNetworkOrThrowUnauthorized(
        options.networkLimit,
        input.network,
        options.permission,
      );

      const purchase = await prisma.purchaseRequest.findUnique({
        where: {
          PaymentSource: {
            deletedAt: null,
            network: input.network,
            smartContractAddress: input.filterSmartContractAddress ?? undefined,
          },
          blockchainIdentifier: input.blockchainIdentifier,
        },
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
      const { totalBuyerFees, totalSellerFees } = calculateTransactionFees(
        purchase.CurrentTransaction,
        purchase.TransactionHistory,
      );

      return {
        ...purchase,
        ...transformPurchaseGetTimestamps(purchase),
        ...transformPurchaseGetAmounts(purchase),
        totalBuyerFees,
        totalSellerFees,
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
