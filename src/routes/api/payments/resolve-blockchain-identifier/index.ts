import { z } from '@/utils/zod-openapi';
import { Network, $Enums } from '@prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import {
  transformPaymentGetTimestamps,
  transformPaymentGetAmounts,
} from '@/utils/shared/transformers';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';
import { paymentResponseSchema } from '@/routes/api/payments';
import { calculateTransactionFees } from '@/utils/shared/fee-calculator';

export const postPaymentRequestSchemaInput = z.object({
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

export const postPaymentRequestSchemaOutput = paymentResponseSchema;

export const resolvePaymentRequestPost = readAuthenticatedEndpointFactory.build(
  {
    method: 'post',
    input: postPaymentRequestSchemaInput,
    output: postPaymentRequestSchemaOutput,
    handler: async ({
      input,
      options,
    }: {
      input: z.infer<typeof postPaymentRequestSchemaInput>;
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

      const result = await prisma.paymentRequest.findUnique({
        where: {
          PaymentSource: {
            deletedAt: null,
            network: input.network,
            smartContractAddress: input.filterSmartContractAddress ?? undefined,
          },
          blockchainIdentifier: input.blockchainIdentifier,
        },
        include: {
          BuyerWallet: true,
          SmartContractWallet: { where: { deletedAt: null } },
          RequestedFunds: true,
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
      if (result == null) {
        throw createHttpError(404, 'Payment not found');
      }

      const decoded = decodeBlockchainIdentifier(result.blockchainIdentifier);
      const { totalBuyerFees, totalSellerFees } = calculateTransactionFees(
        result.CurrentTransaction,
        result.TransactionHistory,
      );

      return {
        ...result,
        ...transformPaymentGetTimestamps(result),
        ...transformPaymentGetAmounts(result),
        totalBuyerFees,
        totalSellerFees,
        agentIdentifier: decoded?.agentIdentifier ?? null,
        CurrentTransaction: result.CurrentTransaction
          ? {
              ...result.CurrentTransaction,
              fees: result.CurrentTransaction.fees?.toString() ?? null,
            }
          : null,
        TransactionHistory: result.TransactionHistory
          ? result.TransactionHistory.map((tx) => ({
              ...tx,
              fees: tx.fees?.toString() ?? null,
            }))
          : null,
      };
    },
  },
);
