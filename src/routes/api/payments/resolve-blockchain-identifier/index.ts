import { z } from 'zod';
import {
  Network,
  OnChainState,
  $Enums,
  PaymentAction,
  PaymentErrorType,
  TransactionStatus,
} from '@prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import {
  transformPaymentGetTimestamps,
  transformPaymentGetAmounts,
} from '@/utils/shared/transformers';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';

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

export const postPaymentRequestSchemaOutput = z.object({
  id: z.string().describe('Unique identifier for the payment'),
  createdAt: z.date().describe('Timestamp when the payment was created'),
  updatedAt: z.date().describe('Timestamp when the payment was last updated'),
  blockchainIdentifier: z
    .string()
    .describe('Unique blockchain identifier for the payment'),
  agentIdentifier: z
    .string()
    .nullable()
    .describe('Identifier of the agent that is being paid'),
  lastCheckedAt: z
    .date()
    .nullable()
    .describe(
      'Timestamp when the payment was last checked on-chain. Null if never checked',
    ),
  payByTime: z
    .string()
    .nullable()
    .describe(
      'Unix timestamp (in milliseconds) by which the buyer must submit the payment transaction. Null if not set',
    ),
  submitResultTime: z
    .string()
    .describe(
      'Unix timestamp (in milliseconds) by which the seller must submit the result',
    ),
  unlockTime: z
    .string()
    .describe(
      'Unix timestamp (in milliseconds) after which funds can be unlocked if no disputes',
    ),
  collateralReturnLovelace: z
    .string()
    .nullable()
    .describe(
      'Amount of collateral to return in lovelace. Null if no collateral',
    ),
  externalDisputeUnlockTime: z
    .string()
    .describe(
      'Unix timestamp (in milliseconds) after which external dispute resolution can occur',
    ),
  requestedById: z
    .string()
    .describe('ID of the API key that created this payment'),
  resultHash: z
    .string()
    .nullable()
    .describe('SHA256 hash of the result submitted by the seller (hex string)'),
  inputHash: z
    .string()
    .nullable()
    .describe('SHA256 hash of the input data for the payment (hex string)'),
  cooldownTime: z
    .number()
    .describe('Cooldown period in milliseconds for the seller to dispute'),
  cooldownTimeOtherParty: z
    .number()
    .describe('Cooldown period in milliseconds for the buyer to dispute'),
  onChainState: z
    .nativeEnum(OnChainState)
    .nullable()
    .describe(
      'Current state of the payment on the blockchain. Null if not yet on-chain',
    ),
  NextAction: z
    .object({
      requestedAction: z
        .nativeEnum(PaymentAction)
        .describe('Next action required for this payment'),
      errorType: z
        .nativeEnum(PaymentErrorType)
        .nullable()
        .describe('Type of error that occurred, if any'),
      errorNote: z
        .string()
        .nullable()
        .describe('Additional details about the error, if any'),
      resultHash: z
        .string()
        .nullable()
        .describe(
          'SHA256 hash of the result to be submitted (hex string). Null if not applicable',
        ),
    })
    .describe('Next action required for this payment'),
  CurrentTransaction: z
    .object({
      id: z.string().describe('Unique identifier for the transaction'),
      createdAt: z
        .date()
        .describe('Timestamp when the transaction was created'),
      updatedAt: z
        .date()
        .describe('Timestamp when the transaction was last updated'),
      txHash: z
        .string()
        .nullable()
        .describe(
          'Cardano transaction hash. Null if transaction not yet submitted',
        ),
      status: z
        .nativeEnum(TransactionStatus)
        .describe('Current status of the transaction'),
      previousOnChainState: z
        .nativeEnum(OnChainState)
        .nullable()
        .describe(
          'Previous on-chain state before this transaction. Null if not applicable',
        ),
      newOnChainState: z
        .nativeEnum(OnChainState)
        .nullable()
        .describe(
          'New on-chain state after this transaction. Null if not applicable',
        ),
    })
    .nullable()
    .describe(
      'Current active transaction for this payment. Null if no transaction in progress',
    ),
  TransactionHistory: z
    .array(
      z.object({
        id: z.string().describe('Unique identifier for the transaction'),
        createdAt: z
          .date()
          .describe('Timestamp when the transaction was created'),
        updatedAt: z
          .date()
          .describe('Timestamp when the transaction was last updated'),
        txHash: z
          .string()
          .nullable()
          .describe(
            'Cardano transaction hash. Null if transaction not yet submitted',
          ),
        status: z
          .nativeEnum(TransactionStatus)
          .describe('Current status of the transaction'),
        previousOnChainState: z
          .nativeEnum(OnChainState)
          .nullable()
          .describe(
            'Previous on-chain state before this transaction. Null if not applicable',
          ),
        newOnChainState: z
          .nativeEnum(OnChainState)
          .nullable()
          .describe(
            'New on-chain state after this transaction. Null if not applicable',
          ),
      }),
    )
    .nullable()
    .describe(
      'Historical list of all transactions for this payment. Null or empty if includeHistory is false',
    ),
  RequestedFunds: z.array(
    z.object({
      amount: z
        .string()
        .describe(
          'The quantity of the asset. Make sure to convert it from the underlying smallest unit (in case of decimals, multiply it by the decimal factor e.g. for 1 ADA = 10000000 lovelace)',
        ),
      unit: z
        .string()
        .describe(
          'Asset policy id + asset name concatenated. Uses an empty string for ADA/lovelace e.g (1000000 lovelace = 1 ADA)',
        ),
    }),
  ),
  WithdrawnForSeller: z
    .array(
      z.object({
        amount: z
          .string()
          .describe(
            'Amount of the asset withdrawn (as string to handle large numbers)',
          ),
        unit: z
          .string()
          .describe(
            'Asset policy id + asset name concatenated. Empty string for ADA/lovelace',
          ),
      }),
    )
    .describe('List of assets and amounts withdrawn for the seller'),
  WithdrawnForBuyer: z
    .array(
      z.object({
        amount: z
          .string()
          .describe(
            'Amount of the asset withdrawn (as string to handle large numbers)',
          ),
        unit: z
          .string()
          .describe(
            'Asset policy id + asset name concatenated. Empty string for ADA/lovelace',
          ),
      }),
    )
    .describe('List of assets and amounts withdrawn for the buyer (refunds)'),
  PaymentSource: z
    .object({
      id: z.string().describe('Unique identifier for the payment source'),
      network: z
        .nativeEnum(Network)
        .describe('The Cardano network (Mainnet, Preprod, or Preview)'),
      smartContractAddress: z
        .string()
        .describe('Address of the smart contract managing this payment'),
      policyId: z
        .string()
        .nullable()
        .describe(
          'Policy ID for the agent registry NFTs. Null if not applicable',
        ),
    })
    .describe('Payment source configuration for this payment'),
  BuyerWallet: z
    .object({
      id: z.string().describe('Unique identifier for the buyer wallet'),
      walletVkey: z.string().describe('Payment key hash of the buyer wallet'),
    })
    .nullable()
    .describe(
      'Buyer wallet information. Null if buyer has not yet submitted payment',
    ),
  SmartContractWallet: z
    .object({
      id: z
        .string()
        .describe('Unique identifier for the smart contract wallet'),
      walletVkey: z
        .string()
        .describe('Payment key hash of the smart contract wallet'),
      walletAddress: z
        .string()
        .describe('Cardano address of the smart contract wallet'),
    })
    .nullable()
    .describe(
      'Smart contract wallet (seller wallet) managing this payment. Null if not set',
    ),
  metadata: z
    .string()
    .nullable()
    .describe(
      'Optional metadata stored with the payment for additional context. Null if not provided',
    ),
});

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
      return {
        ...result,
        agentIdentifier:
          decodeBlockchainIdentifier(result.blockchainIdentifier)
            ?.agentIdentifier ?? null,
        ...transformPaymentGetTimestamps(result),
        ...transformPaymentGetAmounts(result),
      };
    },
  },
);
