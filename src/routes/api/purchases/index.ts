import { z } from '@/utils/zod-openapi';
import {
  HotWalletType,
  Network,
  PurchasingAction,
  TransactionStatus,
  PurchaseErrorType,
  OnChainState,
  PricingType,
  $Enums,
} from '@prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { checkSignature, resolvePaymentKeyHash } from '@meshsdk/core';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { logger } from '@/utils/logger';
import { metadataSchema } from '../registry/wallet';
import { metadataToString } from '@/utils/converter/metadata-string-convert';
import { handlePurchaseCreditInit } from '@/services/token-credit';
import stringify from 'canonical-json';
import { getPublicKeyFromCoseKey } from '@/utils/converter/public-key-convert';
import { generateSHA256Hash } from '@/utils/crypto';
import { validateHexString } from '@/utils/generator/contract-generator';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';
import { HttpExistsError } from '@/utils/errors/http-exists-error';
import { recordBusinessEndpointError } from '@/utils/metrics';
import { WalletAccess } from '@/services/wallet-access';
import { Prisma } from '@prisma/client';
import {
  transformPurchaseGetTimestamps,
  transformPurchaseGetAmounts,
} from '@/utils/shared/transformers';

export const queryPurchaseRequestSchemaInput = z.object({
  limit: z
    .number({ coerce: true })
    .min(1)
    .max(100)
    .default(10)
    .describe('The number of purchases to return'),
  cursorId: z
    .string()
    .optional()
    .describe(
      'Used to paginate through the purchases. If this is provided, cursorId is required',
    ),
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

export const purchaseResponseSchema = z
  .object({
    id: z.string().describe('Unique identifier for the purchase'),
    createdAt: z.date().describe('Timestamp when the purchase was created'),
    updatedAt: z
      .date()
      .describe('Timestamp when the purchase was last updated'),
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
    externalDisputeUnlockTime: z
      .string()
      .describe(
        'Unix timestamp (in milliseconds) after which external dispute resolution can occur',
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
      .describe(
        'SHA256 hash of the result submitted by the seller (hex string)',
      ),
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
        fees: z.string().nullable().describe('Fees of the transaction'),
        blockHeight: z
          .number()
          .nullable()
          .describe('Block height of the transaction'),
        blockTime: z
          .number()
          .nullable()
          .describe('Block time of the transaction'),
        previousOnChainState: z
          .nativeEnum(OnChainState)
          .nullable()
          .describe('Previous on-chain state before this transaction'),

        newOnChainState: z
          .nativeEnum(OnChainState)
          .nullable()
          .describe('New on-chain state of this transaction'),
        confirmations: z
          .number()
          .nullable()
          .describe('Number of block confirmations for this transaction'),
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
          fees: z.string().nullable().describe('Fees of the transaction'),
          blockHeight: z
            .number()
            .nullable()
            .describe('Block height of the transaction'),
          blockTime: z
            .number()
            .nullable()
            .describe('Block time of the transaction'),
          previousOnChainState: z
            .nativeEnum(OnChainState)
            .nullable()
            .describe('Previous on-chain state before this transaction'),
          newOnChainState: z
            .nativeEnum(OnChainState)
            .nullable()
            .describe('New on-chain state of this transaction'),
          confirmations: z
            .number()
            .nullable()
            .describe('Number of block confirmations for this transaction'),
        }),
      )
      .describe('Historical list of all transactions for this purchase'),
    PaidFunds: z.array(
      z.object({
        amount: z.string(),
        unit: z.string(),
      }),
    ),
    WithdrawnForSeller: z.array(
      z.object({
        amount: z.string(),
        unit: z.string(),
      }),
    ),
    WithdrawnForBuyer: z.array(
      z.object({
        amount: z.string(),
        unit: z.string(),
      }),
    ),
    PaymentSource: z.object({
      id: z.string(),
      network: z.nativeEnum(Network),
      smartContractAddress: z.string(),
      policyId: z.string().nullable(),
    }),
    SellerWallet: z
      .object({
        id: z.string().describe('Unique identifier for the seller wallet'),
        walletVkey: z
          .string()
          .describe('Payment key hash of the seller wallet'),
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
  })
  .openapi('Purchase');

export const queryPurchaseRequestSchemaOutput = z.object({
  Purchases: z.array(purchaseResponseSchema),
});

export const queryPurchaseRequestGet = payAuthenticatedEndpointFactory.build({
  method: 'get',
  input: queryPurchaseRequestSchemaInput,
  output: queryPurchaseRequestSchemaOutput,
  handler: async ({
    input,
    options,
  }: {
    input: z.infer<typeof queryPurchaseRequestSchemaInput>;
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

    const baseFilter: Prisma.PurchaseRequestWhereInput = {
      PaymentSource: {
        deletedAt: null,
        network: input.network,
        smartContractAddress: input.filterSmartContractAddress ?? undefined,
      },
      ...(options.permission === $Enums.Permission.WalletScoped && {
        smartContractWalletId: { not: null },
      }),
    };

    const secureFilter = WalletAccess.buildFilter(
      {
        apiKeyId: options.id,
        permission: options.permission,
        allowedWalletIds: options.allowedWalletIds,
      },
      baseFilter,
    );

    const result = await prisma.purchaseRequest.findMany({
      where: secureFilter,
      cursor: input.cursorId ? { id: input.cursorId } : undefined,
      take: input.limit,
      orderBy: { createdAt: 'desc' },
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
      Purchases: result.map((purchase) => ({
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
      })),
    };
  },
});

export const createPurchaseInitSchemaInput = z.object({
  blockchainIdentifier: z
    .string()
    .max(8000)
    .describe('The identifier of the purchase. Is provided by the seller'),
  network: z
    .nativeEnum(Network)
    .describe('The network the transaction will be made on'),
  inputHash: z
    .string()
    .max(250)
    .describe(
      'The hash of the input data of the purchase, should be sha256 hash of the input data, therefore needs to be in hex string format',
    ),
  sellerVkey: z
    .string()
    .max(250)
    .describe('The verification key of the seller'),
  agentIdentifier: z
    .string()
    .min(57)
    .max(250)
    .describe('The identifier of the agent that is being purchased'),
  Amounts: z
    .array(
      z.object({
        amount: z
          .string()
          .max(25)
          .describe(
            'Amount of the asset in smallest unit (e.g., lovelace for ADA)',
          ),
        unit: z
          .string()
          .max(150)
          .describe(
            'Asset policy id + asset name concatenated. Empty string for ADA/lovelace',
          ),
      }),
    )
    .max(7)
    .optional()
    .describe('The amounts to be paid for the purchase'),
  unlockTime: z
    .string()
    .describe(
      'The time after which the purchase will be unlocked. In unix time (number)',
    ),
  externalDisputeUnlockTime: z
    .string()
    .describe(
      'The time after which the purchase will be unlocked for external dispute. In unix time (number)',
    ),
  submitResultTime: z
    .string()
    .describe(
      'The time by which the result has to be submitted. In unix time (number)',
    ),
  payByTime: z
    .string()
    .describe(
      'The time after which the purchase has to be submitted to the smart contract',
    ),
  metadata: z
    .string()
    .optional()
    .describe('Metadata to be stored with the purchase request'),
  identifierFromPurchaser: z
    .string()
    .min(14)
    .max(26)
    .describe(
      'The nonce of the purchaser of the purchase, needs to be in hex format',
    ),
});

export const createPurchaseInitSchemaOutput = purchaseResponseSchema;

export const createPurchaseInitPost = payAuthenticatedEndpointFactory.build({
  method: 'post',
  input: createPurchaseInitSchemaInput,
  output: createPurchaseInitSchemaOutput,
  handler: async ({
    input,
    options,
  }: {
    input: z.infer<typeof createPurchaseInitSchemaInput>;
    options: {
      id: string;
      permission: $Enums.Permission;
      networkLimit: $Enums.Network[];
      usageLimited: boolean;
      allowedWalletIds: string[];
    };
  }) => {
    const startTime = Date.now();
    try {
      await checkIsAllowedNetworkOrThrowUnauthorized(
        options.networkLimit,
        input.network,
        options.permission,
      );
      const existingPurchaseRequest = await prisma.purchaseRequest.findUnique({
        where: {
          blockchainIdentifier: input.blockchainIdentifier,
          PaymentSource: {
            deletedAt: null,
            network: input.network,
          },
        },
        include: {
          SellerWallet: true,
          SmartContractWallet: { where: { deletedAt: null } },
          PaymentSource: true,
          WithdrawnForBuyer: true,
          WithdrawnForSeller: true,
          PaidFunds: true,
          NextAction: true,
          CurrentTransaction: true,
        },
      });
      if (existingPurchaseRequest != null) {
        throw new HttpExistsError(
          'Purchase exists',
          existingPurchaseRequest.id,
          {
            ...existingPurchaseRequest,
            CurrentTransaction: existingPurchaseRequest.CurrentTransaction
              ? {
                  id: existingPurchaseRequest.CurrentTransaction.id,
                  createdAt:
                    existingPurchaseRequest.CurrentTransaction.createdAt,
                  updatedAt:
                    existingPurchaseRequest.CurrentTransaction.updatedAt,
                  txHash: existingPurchaseRequest.CurrentTransaction.txHash,
                  status: existingPurchaseRequest.CurrentTransaction.status,
                  fees:
                    existingPurchaseRequest.CurrentTransaction.fees?.toString() ??
                    null,
                  blockHeight:
                    existingPurchaseRequest.CurrentTransaction.blockHeight,
                  blockTime:
                    existingPurchaseRequest.CurrentTransaction.blockTime,
                  utxoCount:
                    existingPurchaseRequest.CurrentTransaction.utxoCount,
                  withdrawalCount:
                    existingPurchaseRequest.CurrentTransaction.withdrawalCount,
                  assetMintOrBurnCount:
                    existingPurchaseRequest.CurrentTransaction
                      .assetMintOrBurnCount,
                  redeemerCount:
                    existingPurchaseRequest.CurrentTransaction.redeemerCount,
                  validContract:
                    existingPurchaseRequest.CurrentTransaction.validContract,
                  outputAmount:
                    existingPurchaseRequest.CurrentTransaction.outputAmount,
                }
              : null,
            TransactionHistory: [],
            payByTime: existingPurchaseRequest.payByTime?.toString() ?? null,
            PaidFunds: (
              existingPurchaseRequest.PaidFunds as Array<{
                unit: string;
                amount: bigint;
              }>
            ).map((amount) => ({
              ...amount,
              amount: amount.amount.toString(),
            })),
            WithdrawnForSeller: (
              existingPurchaseRequest.WithdrawnForSeller as Array<{
                unit: string;
                amount: bigint;
              }>
            ).map((amount) => ({
              ...amount,
              amount: amount.amount.toString(),
            })),
            WithdrawnForBuyer: (
              existingPurchaseRequest.WithdrawnForBuyer as Array<{
                unit: string;
                amount: bigint;
              }>
            ).map((amount) => ({
              ...amount,
              amount: amount.amount.toString(),
            })),
            submitResultTime:
              existingPurchaseRequest.submitResultTime.toString(),
            unlockTime: existingPurchaseRequest.unlockTime.toString(),
            externalDisputeUnlockTime:
              existingPurchaseRequest.externalDisputeUnlockTime.toString(),
            cooldownTime: Number(existingPurchaseRequest.buyerCoolDownTime),
            cooldownTimeOtherParty: Number(
              existingPurchaseRequest.sellerCoolDownTime,
            ),
            collateralReturnLovelace:
              existingPurchaseRequest.collateralReturnLovelace?.toString() ??
              null,
            metadata: existingPurchaseRequest.metadata,
            buyerCoolDownTime:
              existingPurchaseRequest.buyerCoolDownTime.toString(),
            sellerCoolDownTime:
              existingPurchaseRequest.sellerCoolDownTime.toString(),
          },
        );
      }
      const policyId = input.agentIdentifier.substring(0, 56);

      const paymentSource = await prisma.paymentSource.findFirst({
        where: {
          policyId: policyId,
          network: input.network,
          deletedAt: null,
        },
        include: { PaymentSourceConfig: true },
      });
      const inputHash = input.inputHash;
      if (validateHexString(inputHash) == false) {
        recordBusinessEndpointError(
          '/api/v1/purchase',
          'POST',
          400,
          'Input hash is not a valid hex string',
          {
            network: input.network,
            field: 'inputHash',
            validation_type: 'invalid_hex_string',
          },
        );
        throw createHttpError(400, 'Input hash is not a valid hex string');
      }

      if (paymentSource == null) {
        recordBusinessEndpointError(
          '/api/v1/purchase',
          'POST',
          404,
          'No payment source found for agent identifiers policy id',
          {
            network: input.network,
            policy_id: policyId,
            agent_identifier: input.agentIdentifier,
            step: 'payment_source_lookup',
          },
        );
        throw createHttpError(
          404,
          'No payment source found for agent identifiers policy id',
        );
      }

      if (options.permission === $Enums.Permission.WalletScoped) {
        const purchasingWallets = await prisma.hotWallet.findMany({
          where: {
            paymentSourceId: paymentSource.id,
            type: HotWalletType.Purchasing,
            deletedAt: null,
            id: { in: options.allowedWalletIds },
          },
        });

        if (purchasingWallets.length === 0) {
          throw createHttpError(
            403,
            'Forbidden: No purchasing wallets in this PaymentSource are assigned to your API key',
          );
        }
      }

      const wallets = await prisma.hotWallet.aggregate({
        where: {
          paymentSourceId: paymentSource.id,
          type: HotWalletType.Selling,
          deletedAt: null,
        },
        _count: true,
      });
      if (wallets._count === 0) {
        recordBusinessEndpointError(
          '/api/v1/purchase',
          'POST',
          404,
          'No valid purchasing wallets found',
          {
            network: input.network,
            payment_source_id: paymentSource.id,
            wallet_type: 'selling',
            step: 'wallet_lookup',
          },
        );
        throw createHttpError(404, 'No valid purchasing wallets found');
      }
      //require at least 3 hours between unlock time and the submit result time
      const additionalExternalDisputeUnlockTime = BigInt(1000 * 60 * 15);
      const submitResultTime = BigInt(input.submitResultTime);
      const payByTime = BigInt(input.payByTime);
      const unlockTime = BigInt(input.unlockTime);
      const externalDisputeUnlockTime = BigInt(input.externalDisputeUnlockTime);
      if (payByTime > submitResultTime - BigInt(1000 * 60 * 5)) {
        recordBusinessEndpointError(
          '/api/v1/purchase',
          'POST',
          400,
          'Pay by time must be before submit result time (min. 5 minutes)',
          {
            network: input.network,
            field: 'payByTime',
            validation_type: 'invalid_time_constraint',
            pay_by_time: payByTime.toString(),
            submit_result_time: submitResultTime.toString(),
          },
        );
        throw createHttpError(
          400,
          'Pay by time must be before submit result time (min. 5 minutes)',
        );
      }
      if (payByTime < BigInt(Date.now() - 1000 * 60 * 5)) {
        recordBusinessEndpointError(
          '/api/v1/purchase',
          'POST',
          400,
          'Pay by time must be in the future (max. 5 minutes)',
          {
            network: input.network,
            field: 'payByTime',
            validation_type: 'time_in_past',
            pay_by_time: payByTime.toString(),
            current_time: Date.now().toString(),
          },
        );
        throw createHttpError(
          400,
          'Pay by time must be in the future (max. 5 minutes)',
        );
      }

      if (
        externalDisputeUnlockTime <
        unlockTime + additionalExternalDisputeUnlockTime
      ) {
        throw createHttpError(
          400,
          'External dispute unlock time must be after unlock time (min. 15 minutes difference)',
        );
      }
      if (submitResultTime < BigInt(Date.now() + 1000 * 60 * 15)) {
        throw createHttpError(
          400,
          'Submit result time must be in the future (min. 15 minutes)',
        );
      }
      const offset = BigInt(1000 * 60 * 15);
      if (submitResultTime > unlockTime - offset) {
        throw createHttpError(
          400,
          'Submit result time must be before unlock time with at least 15 minutes difference',
        );
      }
      const provider = new BlockFrostAPI({
        projectId: paymentSource.PaymentSourceConfig.rpcProviderApiKey,
      });

      const assetId = input.agentIdentifier;
      const policyAsset = assetId.startsWith(policyId)
        ? assetId
        : policyId + assetId;
      const assetInWallet = await provider.assetsAddresses(policyAsset, {
        order: 'desc',
        count: 1,
      });

      if (assetInWallet.length == 0) {
        throw createHttpError(404, 'Agent identifier not found');
      }
      const addressOfAsset = assetInWallet[0].address;
      if (addressOfAsset == null) {
        throw createHttpError(404, 'Agent identifier not found');
      }

      const vKey = resolvePaymentKeyHash(addressOfAsset);
      if (vKey != input.sellerVkey) {
        throw createHttpError(400, 'Invalid seller vkey');
      }

      const assetInfo = await provider.assetsById(assetId);
      if (!assetInfo.onchain_metadata) {
        throw createHttpError(404, 'Agent identifier not found');
      }
      const parsedMetadata = metadataSchema.safeParse(
        assetInfo.onchain_metadata,
      );

      if (!parsedMetadata.success || !parsedMetadata.data) {
        const error = parsedMetadata.error;
        logger.error('Error parsing metadata', { error });
        throw createHttpError(
          404,
          'Agent identifier metadata invalid or unsupported',
        );
      }

      const pricing = parsedMetadata.data.agentPricing;
      if (pricing.pricingType != PricingType.Fixed) {
        throw createHttpError(
          400,
          'Agent identifier pricing type not supported',
        );
      }
      const amounts = pricing.fixedPricing;

      const agentIdentifierAmountsMap = new Map<string, bigint>();
      for (const amount of amounts) {
        const unit =
          metadataToString(amount.unit)!.toLowerCase() == ''
            ? ''
            : metadataToString(amount.unit)!;
        if (agentIdentifierAmountsMap.has(unit)) {
          agentIdentifierAmountsMap.set(
            unit,
            agentIdentifierAmountsMap.get(unit)! + BigInt(amount.amount),
          );
        } else {
          agentIdentifierAmountsMap.set(unit, BigInt(amount.amount));
        }
      }
      //for fixed pricing, the amounts must not be provided
      if (input.Amounts != undefined) {
        throw createHttpError(
          400,
          'Agent identifier amounts must not be provided for fixed pricing',
        );
      }
      const decoded = decodeBlockchainIdentifier(input.blockchainIdentifier);
      if (decoded == null) {
        throw createHttpError(
          400,
          'Invalid blockchain identifier, format invalid',
        );
      }
      const purchaserId = decoded.purchaserId;
      const sellerId = decoded.sellerId;
      const signature = decoded.signature;
      const key = decoded.key;

      if (purchaserId != input.identifierFromPurchaser) {
        throw createHttpError(
          400,
          'Invalid blockchain identifier, purchaser id mismatch',
        );
      }
      if (validateHexString(purchaserId) == false) {
        throw createHttpError(
          400,
          'Purchaser identifier is not a valid hex string',
        );
      }
      if (validateHexString(sellerId) == false) {
        throw createHttpError(
          400,
          'Seller identifier is not a valid hex string',
        );
      }
      if (decoded.agentIdentifier != input.agentIdentifier) {
        throw createHttpError(
          400,
          'Invalid blockchain identifier, agent identifier mismatch',
        );
      }

      const cosePublicKey = getPublicKeyFromCoseKey(key);
      if (cosePublicKey == null) {
        throw createHttpError(
          400,
          'Invalid blockchain identifier, key not found',
        );
      }
      const publicKeyHash = cosePublicKey.hash();
      if (publicKeyHash.hex() != input.sellerVkey) {
        throw createHttpError(
          400,
          'Invalid blockchain identifier, key does not match',
        );
      }

      const reconstructedBlockchainIdentifier = {
        inputHash: input.inputHash,
        agentIdentifier: input.agentIdentifier,
        purchaserIdentifier: purchaserId,
        sellerIdentifier: sellerId,
        //RequestedFunds: is null for fixed pricing
        RequestedFunds: null,
        payByTime: input.payByTime,
        submitResultTime: input.submitResultTime,
        unlockTime: unlockTime.toString(),
        externalDisputeUnlockTime: externalDisputeUnlockTime.toString(),
        sellerAddress: addressOfAsset,
      };

      const hashedBlockchainIdentifier = generateSHA256Hash(
        stringify(reconstructedBlockchainIdentifier),
      );

      const identifierIsSignedCorrectly = await checkSignature(
        hashedBlockchainIdentifier,
        {
          signature: signature,
          key: key,
        },
      );
      if (!identifierIsSignedCorrectly) {
        throw createHttpError(
          400,
          'Invalid blockchain identifier, signature invalid',
        );
      }
      const smartContractAddress = paymentSource.smartContractAddress;

      const initialPurchaseRequest = await handlePurchaseCreditInit({
        id: options.id,
        cost: Array.from(agentIdentifierAmountsMap.entries()).map(
          ([unit, amount]) => {
            if (unit.toLowerCase() == 'lovelace') {
              return { amount: amount, unit: '' };
            } else {
              return { amount: amount, unit: unit };
            }
          },
        ),
        metadata: input.metadata,
        network: input.network,
        blockchainIdentifier: input.blockchainIdentifier,
        contractAddress: smartContractAddress,
        sellerVkey: input.sellerVkey,
        sellerAddress: addressOfAsset,
        payByTime: payByTime,
        submitResultTime: submitResultTime,
        unlockTime: unlockTime,
        externalDisputeUnlockTime: externalDisputeUnlockTime,
        inputHash: input.inputHash,
      });

      return {
        ...initialPurchaseRequest,
        ...transformPurchaseGetTimestamps(initialPurchaseRequest),
        ...transformPurchaseGetAmounts(initialPurchaseRequest),
        agentIdentifier: input.agentIdentifier,
        TransactionHistory: [],
        CurrentTransaction: null,
      };
    } catch (error: unknown) {
      // Record the business-specific error with context
      const errorInstance =
        error instanceof Error ? error : new Error(String(error));
      const statusCode =
        (errorInstance as { statusCode?: number; status?: number })
          .statusCode ||
        (errorInstance as { statusCode?: number; status?: number }).status ||
        500;
      recordBusinessEndpointError(
        '/api/v1/purchase',
        'POST',
        statusCode,
        errorInstance,
        {
          network: input.network,
          user_id: options.id,
          agent_identifier: input.agentIdentifier,
          duration: Date.now() - startTime,
          step: 'purchase_processing',
        },
      );

      throw error;
    }
  },
});
