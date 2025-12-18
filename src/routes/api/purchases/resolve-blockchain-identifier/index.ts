import { z } from 'zod';
import {
  Network,
  PurchasingAction,
  TransactionStatus,
  PurchaseErrorType,
  OnChainState,
  $Enums,
} from '@prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import {
  transformPurchaseGetTimestamps,
  transformPurchaseGetAmounts,
} from '@/utils/shared/transformers';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';

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

export const postPurchaseRequestSchemaOutput = z.object({
  id: z.string().describe('Unique identifier for the purchase'),
  createdAt: z.date().describe('Timestamp when the purchase was created'),
  updatedAt: z.date().describe('Timestamp when the purchase was last updated'),
  blockchainIdentifier: z
    .string()
    .describe('Unique blockchain identifier for the purchase'),
  agentIdentifier: z
    .string()
    .nullable()
    .describe('Identifier of the agent that is being purchased'),
  lastCheckedAt: z
    .date()
    .nullable()
    .describe(
      'Timestamp when the purchase was last checked on-chain. Null if never checked',
    ),
  payByTime: z
    .string()
    .nullable()
    .describe(
      'Unix timestamp by which the buyer must submit the payment transaction. Null if not set',
    ),
  submitResultTime: z
    .string()
    .describe('Unix timestamp by which the seller must submit the result'),
  unlockTime: z
    .string()
    .describe(
      'Unix timestamp after which funds can be unlocked if no disputes',
    ),
  externalDisputeUnlockTime: z
    .string()
    .describe(
      'Unix timestamp after which external dispute resolution can occur',
    ),
  requestedById: z
    .string()
    .describe('ID of the API key that created this purchase'),
  onChainState: z
    .nativeEnum(OnChainState)
    .nullable()
    .describe(
      'Current state of the purchase on the blockchain. Null if not yet on-chain',
    ),
  collateralReturnLovelace: z
    .string()
    .nullable()
    .describe(
      'Amount of collateral to return in lovelace. Null if no collateral',
    ),
  cooldownTime: z
    .number()
    .describe('Cooldown period in milliseconds for the buyer to dispute'),
  cooldownTimeOtherParty: z
    .number()
    .describe('Cooldown period in milliseconds for the seller to dispute'),
  inputHash: z
    .string()
    .describe('SHA256 hash of the input data for the purchase (hex string)'),
  resultHash: z
    .string()
    .nullable()
    .describe('SHA256 hash of the result submitted by the seller (hex string)'),
  NextAction: z
    .object({
      requestedAction: z
        .nativeEnum(PurchasingAction)
        .describe('Next action required for this purchase'),
      errorType: z
        .nativeEnum(PurchaseErrorType)
        .nullable()
        .describe('Type of error that occurred, if any'),
      errorNote: z
        .string()
        .nullable()
        .describe('Additional details about the error, if any'),
    })
    .describe('Next action required for this purchase'),
  CurrentTransaction: z
    .object({
      id: z.string().describe('Unique identifier for the transaction'),
      createdAt: z
        .date()
        .describe('Timestamp when the transaction was created'),
      updatedAt: z
        .date()
        .describe('Timestamp when the transaction was last updated'),
      txHash: z.string().nullable().describe('Cardano transaction hash'),
      status: z
        .nativeEnum(TransactionStatus)
        .describe('Current status of the transaction'),
    })
    .nullable()
    .describe(
      'Current active transaction for this purchase. Null if no transaction in progress',
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
        txHash: z.string().nullable().describe('Cardano transaction hash'),
        status: z
          .nativeEnum(TransactionStatus)
          .describe('Current status of the transaction'),
      }),
    )
    .describe(
      'Historical list of all transactions for this purchase. Empty if includeHistory is false',
    ),
  PaidFunds: z.array(
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
        .describe('Address of the smart contract managing this purchase'),
      policyId: z
        .string()
        .nullable()
        .describe(
          'Policy ID for the agent registry NFTs. Null if not applicable',
        ),
    })
    .describe('Payment source configuration for this purchase'),
  SellerWallet: z
    .object({
      id: z.string().describe('Unique identifier for the seller wallet'),
      walletVkey: z.string().describe('Payment key hash of the seller wallet'),
    })
    .nullable()
    .describe('Seller wallet information. Null if not set'),
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
      'Smart contract wallet (seller wallet) managing this purchase. Null if not set',
    ),
  metadata: z
    .string()
    .nullable()
    .describe(
      'Optional metadata stored with the purchase for additional context. Null if not provided',
    ),
});

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

      const result = await prisma.purchaseRequest.findUnique({
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
      if (result == null) {
        throw createHttpError(404, 'Purchase not found');
      }
      return {
        ...result,
        agentIdentifier:
          decodeBlockchainIdentifier(result.blockchainIdentifier)
            ?.agentIdentifier ?? null,
        ...transformPurchaseGetTimestamps(result),
        ...transformPurchaseGetAmounts(result),
      };
    },
  });
