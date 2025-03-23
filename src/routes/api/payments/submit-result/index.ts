import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import { z } from 'zod';
import {
  Network,
  OnChainState,
  PaymentAction,
  PaymentErrorType,
  PaymentType,
  Permission,
} from '@prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { DEFAULTS } from '@/utils/config';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';

export const submitPaymentResultSchemaInput = z.object({
  network: z
    .nativeEnum(Network)
    .describe('The network the payment was received on'),
  smartContractAddress: z
    .string()
    .max(250)
    .optional()
    .describe(
      'The address of the smart contract where the payment was made to',
    ),
  submitResultHash: z
    .string()
    .max(250)
    .describe('The hash of the AI agent result to be submitted'),
  blockchainIdentifier: z
    .string()
    .max(8000)
    .describe('The identifier of the payment'),
});

export const submitPaymentResultSchemaOutput = z.object({
  id: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
  blockchainIdentifier: z.string(),
  submitResultTime: z.string(),
  unlockTime: z.string(),
  externalDisputeUnlockTime: z.string(),
  lastCheckedAt: z.date().nullable(),
  requestedById: z.string(),
  resultHash: z.string(),
  inputHash: z.string(),
  onChainState: z.nativeEnum(OnChainState).nullable(),
  NextAction: z.object({
    requestedAction: z.nativeEnum(PaymentAction),
    errorType: z.nativeEnum(PaymentErrorType).nullable(),
    errorNote: z.string().nullable(),
    resultHash: z.string().nullable(),
  }),
  RequestedFunds: z.array(
    z.object({
      id: z.string(),
      createdAt: z.date(),
      updatedAt: z.date(),
      amount: z.string(),
      unit: z.string(),
    }),
  ),
  PaymentSource: z.object({
    id: z.string(),
    network: z.nativeEnum(Network),
    smartContractAddress: z.string(),
    paymentType: z.nativeEnum(PaymentType),
  }),
  BuyerWallet: z
    .object({
      id: z.string(),
      walletVkey: z.string(),
    })
    .nullable(),
  SmartContractWallet: z
    .object({
      id: z.string(),
      walletVkey: z.string(),
      walletAddress: z.string(),
    })
    .nullable(),
  metadata: z.string().nullable(),
});

export const submitPaymentResultEndpointPost =
  readAuthenticatedEndpointFactory.build({
    method: 'post',
    input: submitPaymentResultSchemaInput,
    output: submitPaymentResultSchemaOutput,
    handler: async ({ input, options }) => {
      const smartContractAddress =
        input.smartContractAddress ??
        (input.network == Network.Mainnet
          ? DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_MAINNET
          : DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_PREPROD);
      const specifiedPaymentContract = await prisma.paymentSource.findUnique({
        where: {
          network_smartContractAddress: {
            network: input.network,
            smartContractAddress: smartContractAddress,
          },
        },
        include: {
          HotWallets: true,
          PaymentSourceConfig: true,
          PaymentRequests: {
            where: {
              onChainState: {
                in: [
                  OnChainState.RefundRequested,
                  OnChainState.Disputed,
                  OnChainState.FundsLocked,
                ],
              },
              blockchainIdentifier: input.blockchainIdentifier,
              NextAction: {
                requestedAction: {
                  in: [PaymentAction.WaitingForExternalAction],
                },
              },
            },
            include: {
              NextAction: true,
              SmartContractWallet: true,
            },
          },
        },
      });
      if (specifiedPaymentContract == null) {
        throw createHttpError(
          404,
          'Network and Address combination not supported',
        );
      }
      if (specifiedPaymentContract.PaymentRequests.length == 0) {
        throw createHttpError(404, 'Payment not found or in invalid state');
      }
      const payment = specifiedPaymentContract.PaymentRequests[0];
      if (
        payment.requestedById != options.id &&
        options.permission != Permission.Admin
      ) {
        throw createHttpError(
          403,
          'You are not authorized to submit results for this payment',
        );
      }
      if (payment.SmartContractWallet == null) {
        throw createHttpError(404, 'Smart contract wallet not found');
      }
      await checkIsAllowedNetworkOrThrowUnauthorized(
        options.networkLimit,
        input.network,
        options.permission,
      );

      const result = await prisma.paymentRequest.update({
        where: { id: specifiedPaymentContract.PaymentRequests[0].id },
        data: {
          NextAction: {
            update: {
              requestedAction: PaymentAction.SubmitResultRequested,
              resultHash: input.submitResultHash,
            },
          },
        },
        include: {
          NextAction: true,
          BuyerWallet: true,
          SmartContractWallet: true,
          PaymentSource: true,
          RequestedFunds: true,
        },
      });

      return {
        ...result,
        submitResultTime: result.submitResultTime.toString(),
        unlockTime: result.unlockTime.toString(),
        externalDisputeUnlockTime: result.externalDisputeUnlockTime.toString(),
        RequestedFunds: result.RequestedFunds.map((amount) => ({
          ...amount,
          amount: amount.amount.toString(),
        })),
      };
    },
  });
