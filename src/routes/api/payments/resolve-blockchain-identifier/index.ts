import { z } from '@/utils/zod-openapi';
import { Network, PaymentAction, PaymentErrorType } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import {
  AuthContext,
  checkIsAllowedNetworkOrThrowUnauthorized,
} from '@/utils/middleware/auth-middleware';
import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import {
  transformPaymentGetTimestamps,
  transformPaymentGetAmounts,
} from '@/utils/shared/transformers';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';
import { paymentResponseSchema } from '@/routes/api/payments';

export const postPaymentRequestSchemaInput = z.object({
  blockchainIdentifier: z.string().describe('The blockchain identifier to resolve'),
  network: z.nativeEnum(Network).describe('The network the purchases were made on'),
  filterSmartContractAddress: z
    .string()
    .optional()
    .nullable()
    .describe('The smart contract address of the payment source'),

  includeHistory: z
    .string()
    .default('false')
    .optional()
    .transform((val) => val?.toLowerCase() == 'true')
    .describe('Whether to include the full transaction and status history of the purchases'),
});

export const postPaymentRequestSchemaOutput = paymentResponseSchema;

export const resolvePaymentRequestPost = readAuthenticatedEndpointFactory.build({
  method: 'post',
  input: postPaymentRequestSchemaInput,
  output: postPaymentRequestSchemaOutput,
  handler: async ({
    input,
    ctx,
  }: {
    input: z.infer<typeof postPaymentRequestSchemaInput>;
    ctx: AuthContext;
  }) => {
    await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network, ctx.permission);

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
        BuyerWallet: { select: { id: true, walletVkey: true } },
        SmartContractWallet: {
          where: { deletedAt: null },
          select: { id: true, walletVkey: true, walletAddress: true },
        },
        RequestedFunds: { select: { id: true, amount: true, unit: true } },
        NextAction: {
          select: {
            id: true,
            requestedAction: true,
            errorType: true,
            errorNote: true,
            resultHash: true,
          },
        },
        PaymentSource: {
          select: {
            id: true,
            network: true,
            smartContractAddress: true,
            policyId: true,
          },
        },
        CurrentTransaction: {
          select: {
            id: true,
            createdAt: true,
            updatedAt: true,
            fees: true,
            blockHeight: true,
            blockTime: true,
            txHash: true,
            status: true,
            previousOnChainState: true,
            newOnChainState: true,
            confirmations: true,
          },
        },
        WithdrawnForSeller: {
          select: { id: true, amount: true, unit: true },
        },
        WithdrawnForBuyer: {
          select: { id: true, amount: true, unit: true },
        },
        TransactionHistory:
          input.includeHistory == true
            ? {
                orderBy: { createdAt: 'desc' },
                select: {
                  id: true,
                  createdAt: true,
                  updatedAt: true,
                  txHash: true,
                  status: true,
                  fees: true,
                  blockHeight: true,
                  blockTime: true,
                  previousOnChainState: true,
                  newOnChainState: true,
                  confirmations: true,
                },
              }
            : undefined,
        ActionHistory:
          input.includeHistory == true
            ? {
                orderBy: { createdAt: 'desc' },
                select: {
                  id: true,
                  createdAt: true,
                  updatedAt: true,
                  requestedAction: true,
                  errorType: true,
                  errorNote: true,
                  resultHash: true,
                },
              }
            : undefined,
      },
    });
    if (result == null) {
      throw createHttpError(404, 'Payment not found');
    }

    const decoded = decodeBlockchainIdentifier(result.blockchainIdentifier);

    return {
      ...result,
      ...transformPaymentGetTimestamps(result),
      ...transformPaymentGetAmounts(result),
      totalBuyerCardanoFees: Number(result.totalBuyerCardanoFees.toString()) / 1_000_000,
      totalSellerCardanoFees: Number(result.totalSellerCardanoFees.toString()) / 1_000_000,
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
      ActionHistory: result.ActionHistory
        ? (
            result.ActionHistory as Array<{
              id: string;
              createdAt: Date;
              updatedAt: Date;
              submittedTxHash: string | null;
              requestedAction: PaymentAction;
              errorType: PaymentErrorType | null;
              errorNote: string | null;
              resultHash: string | null;
            }>
          ).map((action) => ({
            id: action.id,
            createdAt: action.createdAt,
            updatedAt: action.updatedAt,
            submittedTxHash: action.submittedTxHash,
            requestedAction: action.requestedAction,
            errorType: action.errorType,
            errorNote: action.errorNote,
            resultHash: action.resultHash,
          }))
        : null,
    };
  },
});
