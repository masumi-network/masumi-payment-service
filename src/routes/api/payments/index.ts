import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import { z } from '@/utils/zod-openapi';
import {
  $Enums,
  HotWalletType,
  Network,
  OnChainState,
  PaymentAction,
  PaymentErrorType,
  PricingType,
  TransactionStatus,
} from '@prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { ez } from 'express-zod-api';
import cuid2 from '@paralleldrive/cuid2';
import { MeshWallet, resolvePaymentKeyHash } from '@meshsdk/core';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { convertNetworkToId } from '@/utils/converter/network-convert';
import { decrypt } from '@/utils/security/encryption';
import { metadataSchema } from '../registry/wallet';
import { metadataToString } from '@/utils/converter/metadata-string-convert';
import { generateSHA256Hash } from '@/utils/crypto';
import stringify from 'canonical-json';
import {
  decodeBlockchainIdentifier,
  generateBlockchainIdentifier,
} from '@/utils/generator/blockchain-identifier-generator';
import { validateHexString } from '@/utils/validator/hex';
import {
  transformPaymentGetTimestamps,
  transformPaymentGetAmounts,
} from '@/utils/shared/transformers';
import { extractPolicyId } from '@/utils/converter/agent-identifier';
import { getBlockfrostInstance } from '@/utils/blockfrost';

export const queryPaymentsSchemaInput = z.object({
  limit: z
    .number({ coerce: true })
    .min(1)
    .max(100)
    .default(10)
    .describe('The number of payments to return'),
  cursorId: z
    .string()
    .optional()
    .describe(
      'Used to paginate through the payments. If this is provided, cursorId is required',
    ),
  network: z
    .nativeEnum(Network)
    .describe('The network the payments were made on'),
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
      'Whether to include the full transaction and status history of the payments',
    ),
});

export const paymentResponseSchema = z
  .object({
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
      .describe(
        'SHA256 hash of the result submitted by the seller (hex string)',
      ),
    nextActionLastChangedAt: z
      .date()
      .describe('Timestamp when the next action was last changed'),
    onChainStateOrResultLastChangedAt: z
      .date()
      .describe('Timestamp when the on-chain state or result was last changed'),
    nextActionOrOnChainStateOrResultLastChangedAt: z
      .date()
      .describe(
        'Timestamp when the next action or on-chain state or result was last changed',
      ),
    inputHash: z
      .string()
      .nullable()
      .describe('SHA256 hash of the input data for the payment (hex string)'),
    totalBuyerCardanoFees: z
      .number()
      .describe(
        'Total Cardano transaction fees paid by the buyer in ADA (sum of all confirmed transactions initiated by buyer)',
      ),
    totalSellerCardanoFees: z
      .number()
      .describe(
        'Total Cardano transaction fees paid by the seller in ADA (sum of all confirmed transactions initiated by seller)',
      ),
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
        fees: z.string().nullable(),
        blockHeight: z
          .number()
          .nullable()
          .describe('Block height of the transaction'),
        blockTime: z
          .number()
          .nullable()
          .describe('Block time of the transaction'),
        txHash: z.string().nullable().describe('Cardano transaction hash'),
        status: z
          .nativeEnum(TransactionStatus)
          .describe('Current status of the transaction'),
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
            'Asset policy id + asset name concatenated. Use an empty string for ADA/lovelace e.g (1000000 lovelace = 1 ADA)',
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
  })
  .openapi('Payment');

export const queryPaymentsSchemaOutput = z.object({
  Payments: z.array(paymentResponseSchema),
});

export const queryPaymentEntryGet = readAuthenticatedEndpointFactory.build({
  method: 'get',
  input: queryPaymentsSchemaInput,
  output: queryPaymentsSchemaOutput,
  handler: async ({
    input,
    options,
  }: {
    input: z.infer<typeof queryPaymentsSchemaInput>;
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

    const result = await prisma.paymentRequest.findMany({
      where: {
        PaymentSource: {
          network: input.network,
          smartContractAddress: input.filterSmartContractAddress ?? undefined,
          deletedAt: null,
        },
      },
      orderBy: { createdAt: 'desc' },
      cursor: input.cursorId
        ? {
            id: input.cursorId,
          }
        : undefined,
      take: input.limit,
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
      },
    });
    if (result == null) {
      throw createHttpError(404, 'Payment not found');
    }

    return {
      Payments: result.map((payment) => {
        return {
          ...payment,
          ...transformPaymentGetTimestamps(payment),
          ...transformPaymentGetAmounts(payment),
          totalBuyerCardanoFees:
            Number(payment.totalBuyerCardanoFees.toString()) / 1_000_000,
          totalSellerCardanoFees:
            Number(payment.totalSellerCardanoFees.toString()) / 1_000_000,
          agentIdentifier:
            decodeBlockchainIdentifier(payment.blockchainIdentifier)
              ?.agentIdentifier ?? null,
          CurrentTransaction: payment.CurrentTransaction
            ? {
                ...payment.CurrentTransaction,
                fees: payment.CurrentTransaction.fees?.toString() ?? null,
              }
            : null,
          TransactionHistory: payment.TransactionHistory
            ? payment.TransactionHistory.map((tx) => ({
                ...tx,
                fees: tx.fees?.toString() ?? null,
              }))
            : null,
        };
      }),
    };
  },
});

export const createPaymentsSchemaInput = z.object({
  inputHash: z
    .string()
    .max(250)
    .describe(
      'The hash of the input data of the payment, should be sha256 hash of the input data, therefore needs to be in hex string format',
    ),
  network: z
    .nativeEnum(Network)
    .describe('The network the payment will be received on'),
  agentIdentifier: z
    .string()
    .min(57)
    .max(250)
    .describe('The identifier of the agent that will be paid'),
  RequestedFunds: z
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
    .describe('The amounts of the payment, should be null for fixed amount'),
  payByTime: ez
    .dateIn()
    .default(new Date(1000 * 60 * 60 * 12).toISOString())
    .describe(
      'The time after which the payment has to be submitted to the smart contract',
    ),
  submitResultTime: ez
    .dateIn()
    .default(new Date(1000 * 60 * 60 * 12).toISOString())
    .describe(
      'The time after which the payment has to be submitted to the smart contract',
    ),
  unlockTime: ez
    .dateIn()
    .optional()
    .describe('The time after which the payment will be unlocked'),
  externalDisputeUnlockTime: ez
    .dateIn()
    .optional()
    .describe(
      'The time after which the payment will be unlocked for external dispute',
    ),
  metadata: z
    .string()
    .optional()
    .describe('Metadata to be stored with the payment request'),
  identifierFromPurchaser: z
    .string()
    .min(14)
    .max(26)
    .describe(
      'The a unique nonce from the purchaser. Required to be in hex format',
    ),
});

export const createPaymentSchemaOutput = paymentResponseSchema.omit({
  TransactionHistory: true,
});

export const paymentInitPost = readAuthenticatedEndpointFactory.build({
  method: 'post',
  input: createPaymentsSchemaInput,
  output: createPaymentSchemaOutput,
  handler: async ({
    input,
    options,
  }: {
    input: z.infer<typeof createPaymentsSchemaInput>;
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
    const policyId = extractPolicyId(input.agentIdentifier);

    const specifiedPaymentContract = await prisma.paymentSource.findFirst({
      where: {
        network: input.network,
        policyId: policyId,
        deletedAt: null,
      },
      include: {
        PaymentSourceConfig: {
          select: { rpcProviderApiKey: true, rpcProvider: true },
        },
      },
    });
    if (specifiedPaymentContract == null) {
      throw createHttpError(
        404,
        'Network and policyId combination not supported',
      );
    }
    await checkIsAllowedNetworkOrThrowUnauthorized(
      options.networkLimit,
      input.network,
      options.permission,
    );
    const purchaserId = input.identifierFromPurchaser;
    if (validateHexString(purchaserId) == false) {
      throw createHttpError(
        400,
        'Purchaser identifier is not a valid hex string',
      );
    }
    const inputHash = input.inputHash;
    if (validateHexString(inputHash) == false) {
      throw createHttpError(400, 'Input hash is not a valid hex string');
    }

    const payByTime = BigInt(input.payByTime.getTime());
    const submitResultTime = BigInt(input.submitResultTime.getTime());

    const unlockTime =
      input.unlockTime != undefined
        ? input.unlockTime.getTime()
        : new Date(
            input.submitResultTime.getTime() + 1000 * 60 * 60 * 6,
          ).getTime(); // default +6h

    const externalDisputeUnlockTime =
      input.externalDisputeUnlockTime != undefined
        ? input.externalDisputeUnlockTime.getTime()
        : new Date(
            input.submitResultTime.getTime() + 1000 * 60 * 60 * 12,
          ).getTime(); // default +12h

    //require at least 3 hours between unlock time and the submit result time
    const additionalExternalDisputeUnlockTime = BigInt(1000 * 60 * 15);

    if (payByTime > submitResultTime - BigInt(1000 * 60 * 5)) {
      throw createHttpError(
        400,
        'Pay by time must be before submit result time (min. 5 minutes)',
      );
    }
    if (payByTime < BigInt(Date.now() - 1000 * 60 * 5)) {
      throw createHttpError(
        400,
        'Pay by time must be in the future (max. 5 minutes)',
      );
    }

    if (
      externalDisputeUnlockTime <
      BigInt(unlockTime) + additionalExternalDisputeUnlockTime
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
    if (submitResultTime > BigInt(unlockTime) - offset) {
      throw createHttpError(
        400,
        'Submit result time must be before unlock time with at least 15 minutes difference',
      );
    }

    const provider = getBlockfrostInstance(
      input.network,
      specifiedPaymentContract.PaymentSourceConfig.rpcProviderApiKey,
    );

    if (input.agentIdentifier.startsWith(policyId) == false) {
      throw createHttpError(
        404,
        'The agentIdentifier is not of the specified payment source',
      );
    }
    let assetInWallet = [];
    try {
      assetInWallet = await provider.assetsAddresses(input.agentIdentifier, {
        order: 'desc',
        count: 1,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        throw createHttpError(404, 'Agent identifier not found');
      }
      throw createHttpError(500, 'Error fetching asset in wallet');
    }

    if (assetInWallet.length == 0) {
      throw createHttpError(404, 'Agent identifier not found');
    }

    const assetMetadata = await provider.assetsById(input.agentIdentifier);
    if (!assetMetadata || !assetMetadata.onchain_metadata) {
      throw createHttpError(404, 'Agent registry metadata not found');
    }
    const parsedMetadata = metadataSchema.safeParse(
      assetMetadata.onchain_metadata,
    );
    if (!parsedMetadata.success) {
      throw createHttpError(404, 'Agent registry metadata not valid');
    }
    const pricing = parsedMetadata.data.agentPricing;
    if (
      pricing.pricingType == PricingType.Fixed &&
      input.RequestedFunds != null
    ) {
      throw createHttpError(
        400,
        'For fixed pricing, RequestedFunds must be null',
      );
    } else if (pricing.pricingType != PricingType.Fixed) {
      throw createHttpError(400, 'Non fixed price not supported yet');
    }

    const amounts = pricing.fixedPricing.map((amount) => ({
      amount: amount.amount,
      unit:
        metadataToString(amount.unit)?.toLowerCase() == 'lovelace'
          ? ''
          : metadataToString(amount.unit)!,
    }));

    const vKey = resolvePaymentKeyHash(assetInWallet[0].address);

    const sellingWallet = await prisma.hotWallet.findFirst({
      where: {
        deletedAt: null,
        type: HotWalletType.Selling,
        walletVkey: vKey,
        paymentSourceId: specifiedPaymentContract.id,
      },
      include: {
        Secret: {
          select: { encryptedMnemonic: true },
        },
      },
    });
    if (sellingWallet == null) {
      throw createHttpError(404, 'Selling wallet not found');
    }
    const sellerCUID = cuid2.createId();
    const sellerId = generateSHA256Hash(sellerCUID) + input.agentIdentifier;
    const blockchainIdentifier = {
      inputHash: input.inputHash,
      agentIdentifier: input.agentIdentifier,
      purchaserIdentifier: input.identifierFromPurchaser,
      sellerIdentifier: sellerId,
      //RequestedFunds: is null for fixed pricing
      RequestedFunds: null,
      payByTime: input.payByTime.getTime().toString(),
      submitResultTime: input.submitResultTime.getTime().toString(),
      unlockTime: unlockTime.toString(),
      externalDisputeUnlockTime: externalDisputeUnlockTime.toString(),
      sellerAddress: sellingWallet.walletAddress,
    };

    const meshWallet = new MeshWallet({
      networkId: convertNetworkToId(input.network),
      key: {
        type: 'mnemonic',
        words: decrypt(sellingWallet.Secret.encryptedMnemonic).split(' '),
      },
    });

    const hashedBlockchainIdentifier = generateSHA256Hash(
      stringify(blockchainIdentifier),
    );
    const signedBlockchainIdentifier = await meshWallet.signData(
      hashedBlockchainIdentifier,
      sellingWallet.walletAddress,
    );

    const compressedEncodedBlockchainIdentifier = generateBlockchainIdentifier(
      signedBlockchainIdentifier.key,
      signedBlockchainIdentifier.signature,
      sellerId,
      input.identifierFromPurchaser,
    );

    const payment = await prisma.paymentRequest.create({
      data: {
        totalBuyerCardanoFees: BigInt(0),
        totalSellerCardanoFees: BigInt(0),
        blockchainIdentifier: compressedEncodedBlockchainIdentifier,
        PaymentSource: { connect: { id: specifiedPaymentContract.id } },
        RequestedFunds: {
          createMany: {
            data: amounts.map((amount) => {
              return { amount: BigInt(amount.amount), unit: amount.unit };
            }),
          },
        },
        NextAction: {
          create: {
            requestedAction: PaymentAction.WaitingForExternalAction,
          },
        },
        inputHash: input.inputHash,
        resultHash: '',
        SmartContractWallet: {
          connect: { id: sellingWallet.id, deletedAt: null },
        },
        payByTime: input.payByTime.getTime(),
        submitResultTime: input.submitResultTime.getTime(),
        unlockTime: unlockTime,
        externalDisputeUnlockTime: externalDisputeUnlockTime,
        sellerCoolDownTime: 0,
        buyerCoolDownTime: 0,
        requestedBy: { connect: { id: options.id } },
        metadata: input.metadata,
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
      },
    });
    if (payment.SmartContractWallet == null) {
      throw createHttpError(500, 'Smart contract wallet not connected');
    }

    return {
      ...payment,
      ...transformPaymentGetTimestamps(payment),
      ...transformPaymentGetAmounts(payment),
      totalBuyerCardanoFees:
        Number(payment.totalBuyerCardanoFees.toString()) / 1_000_000,
      totalSellerCardanoFees:
        Number(payment.totalSellerCardanoFees.toString()) / 1_000_000,
      agentIdentifier:
        decodeBlockchainIdentifier(payment.blockchainIdentifier)
          ?.agentIdentifier ?? null,
      CurrentTransaction: payment.CurrentTransaction
        ? {
            ...payment.CurrentTransaction,
            fees: payment.CurrentTransaction.fees?.toString() ?? null,
          }
        : null,
    };
  },
});
