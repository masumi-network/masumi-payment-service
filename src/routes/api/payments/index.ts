import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import { z } from 'zod';
import {
  $Enums,
  HotWalletType,
  Network,
  OnChainState,
  PaymentAction,
  PaymentErrorType,
  PricingType,
} from '@prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { ez } from 'express-zod-api';
import cuid2 from '@paralleldrive/cuid2';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { MeshWallet, resolvePaymentKeyHash } from '@meshsdk/core';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { convertNetworkToId } from '@/utils/converter/network-convert';
import { decrypt } from '@/utils/security/encryption';
import { metadataSchema } from '../registry/wallet';
import { metadataToString } from '@/utils/converter/metadata-string-convert';
import { generateHash } from '@/utils/crypto';
import stringify from 'canonical-json';
import { generateBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';
import { validateHexString } from '@/utils/generator/contract-generator';
import {
  parseDateRange,
  filterByAgentIdentifier,
  aggregateEarnings,
  TransactionWithFunds,
} from '../earnings-helpers';
import { recordBusinessEndpointError } from '@/utils/metrics';

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

export const queryPaymentsSchemaOutput = z.object({
  Payments: z.array(
    z.object({
      id: z.string(),
      createdAt: z.date(),
      updatedAt: z.date(),
      blockchainIdentifier: z.string(),
      lastCheckedAt: z.date().nullable(),
      payByTime: z.string().nullable(),
      submitResultTime: z.string(),
      unlockTime: z.string(),
      collateralReturnLovelace: z.string().nullable(),
      externalDisputeUnlockTime: z.string(),
      requestedById: z.string(),
      resultHash: z.string(),
      inputHash: z.string(),
      cooldownTime: z.number(),
      cooldownTimeOtherParty: z.number(),
      onChainState: z.nativeEnum(OnChainState).nullable(),
      NextAction: z.object({
        requestedAction: z.nativeEnum(PaymentAction),
        errorType: z.nativeEnum(PaymentErrorType).nullable(),
        errorNote: z.string().nullable(),
        resultHash: z.string().nullable(),
      }),
      CurrentTransaction: z
        .object({
          id: z.string(),
          createdAt: z.date(),
          updatedAt: z.date(),
          txHash: z.string().nullable(),
        })
        .nullable(),
      TransactionHistory: z
        .array(
          z.object({
            id: z.string(),
            createdAt: z.date(),
            updatedAt: z.date(),
            txHash: z.string().nullable(),
          }),
        )
        .nullable(),
      RequestedFunds: z.array(
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
    }),
  ),
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
        BuyerWallet: true,
        SmartContractWallet: { where: { deletedAt: null } },
        PaymentSource: true,
        RequestedFunds: { include: { AgentFixedPricing: true } },
        NextAction: true,
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
      Payments: result.map((payment) => ({
        ...payment,
        submitResultTime: payment.submitResultTime.toString(),
        cooldownTime: Number(payment.sellerCoolDownTime),
        cooldownTimeOtherParty: Number(payment.buyerCoolDownTime),
        payByTime: payment.payByTime?.toString() ?? null,
        unlockTime: payment.unlockTime.toString(),
        externalDisputeUnlockTime: payment.externalDisputeUnlockTime.toString(),
        collateralReturnLovelace:
          payment.collateralReturnLovelace?.toString() ?? null,
        RequestedFunds: (
          payment.RequestedFunds as Array<{ unit: string; amount: bigint }>
        ).map((amount) => ({
          ...amount,
          amount: amount.amount.toString(),
        })),
        WithdrawnForSeller: (
          payment.WithdrawnForSeller as Array<{ unit: string; amount: bigint }>
        ).map((amount) => ({
          unit: amount.unit,
          amount: amount.amount.toString(),
        })),
        WithdrawnForBuyer: (
          payment.WithdrawnForBuyer as Array<{ unit: string; amount: bigint }>
        ).map((amount) => ({
          unit: amount.unit,
          amount: amount.amount.toString(),
        })),
      })),
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
    .array(z.object({ amount: z.string().max(25), unit: z.string().max(150) }))
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

export const createPaymentSchemaOutput = z.object({
  id: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
  blockchainIdentifier: z.string(),
  payByTime: z.string(),
  submitResultTime: z.string(),
  unlockTime: z.string(),
  externalDisputeUnlockTime: z.string(),
  lastCheckedAt: z.date().nullable(),
  requestedById: z.string(),
  inputHash: z.string(),
  resultHash: z.string(),
  onChainState: z.nativeEnum(OnChainState).nullable(),
  NextAction: z.object({
    requestedAction: z.nativeEnum(PaymentAction),
    resultHash: z.string().nullable(),
    errorType: z.nativeEnum(PaymentErrorType).nullable(),
    errorNote: z.string().nullable(),
  }),
  RequestedFunds: z.array(
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
    const policyId = input.agentIdentifier.slice(0, 56);

    const specifiedPaymentContract = await prisma.paymentSource.findFirst({
      where: {
        network: input.network,
        policyId: policyId,
        deletedAt: null,
      },
      include: {
        HotWallets: { include: { Secret: true }, where: { deletedAt: null } },
        PaymentSourceConfig: true,
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

    const provider = new BlockFrostAPI({
      projectId: specifiedPaymentContract.PaymentSourceConfig.rpcProviderApiKey,
    });

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

    const sellingWallet = specifiedPaymentContract.HotWallets.find(
      (wallet) =>
        wallet.walletVkey == vKey && wallet.type == HotWalletType.Selling,
    );
    if (sellingWallet == null) {
      throw createHttpError(
        404,
        'Agent identifier not found in selling wallets',
      );
    }
    const sellerCUID = cuid2.createId();
    const sellerId = generateHash(sellerCUID) + input.agentIdentifier;
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

    const hashedBlockchainIdentifier = generateHash(
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
        RequestedFunds: true,
        BuyerWallet: true,
        SmartContractWallet: { where: { deletedAt: null } },
        PaymentSource: true,
        NextAction: true,
        CurrentTransaction: true,
        TransactionHistory: true,
        WithdrawnForSeller: true,
        WithdrawnForBuyer: true,
      },
    });
    if (payment.SmartContractWallet == null) {
      throw createHttpError(500, 'Smart contract wallet not connected');
    }
    return {
      ...payment,
      payByTime: payment.payByTime!.toString(),
      submitResultTime: payment.submitResultTime.toString(),
      unlockTime: payment.unlockTime.toString(),
      externalDisputeUnlockTime: payment.externalDisputeUnlockTime.toString(),
      RequestedFunds: (
        payment.RequestedFunds as Array<{ unit: string; amount: bigint }>
      ).map((amount) => ({
        ...amount,
        amount: amount.amount.toString(),
      })),
      WithdrawnForSeller: (
        payment.WithdrawnForSeller as Array<{ unit: string; amount: bigint }>
      ).map((amount) => ({
        unit: amount.unit,
        amount: amount.amount.toString(),
      })),
      WithdrawnForBuyer: (
        payment.WithdrawnForBuyer as Array<{ unit: string; amount: bigint }>
      ).map((amount) => ({
        unit: amount.unit,
        amount: BigInt(amount.amount).toString(),
      })),
    };
  },
});

export const getPaymentEarningsSchemaInput = z.object({
  agentIdentifier: z
    .string()
    .min(57)
    .max(250)
    .describe('The unique identifier of the agent to get payment earnings for'),
  startDate: z
    .string()
    .date()
    .optional()
    .nullable()
    .describe(
      'Start date for earnings calculation (date format: 2024-01-01). If null, uses earliest available data',
    ),
  endDate: z
    .string()
    .date()
    .optional()
    .nullable()
    .describe(
      'End date for earnings calculation (date format: 2024-01-31). If null, uses current date',
    ),
  network: z
    .nativeEnum(Network)
    .describe('The Cardano network to query earnings from'),
});

export const getPaymentEarningsSchemaOutput = z.object({
  agentIdentifier: z.string(),
  dateRange: z.string().describe('Actual date range used for calculation'),
  periodStart: z.date(),
  periodEnd: z.date(),
  totalTransactions: z.number(),
  totalEarnings: z.array(
    z.object({
      unit: z.string(),
      amount: z.string(),
    }),
  ),
  totalFeesPaid: z.array(
    z.object({
      unit: z.string(),
      amount: z.string(),
    }),
  ),
  totalRevenue: z.array(
    z.object({
      unit: z.string(),
      amount: z.string(),
    }),
  ),
  monthlyBreakdown: z
    .array(
      z.object({
        month: z.string(),
        year: z.number(),
        earnings: z.array(
          z.object({
            unit: z.string(),
            amount: z.string(),
          }),
        ),
        transactions: z.number(),
      }),
    )
    .optional(),
  dailyEarnings: z.array(
    z.object({
      date: z.string(),
      earnings: z.array(
        z.object({
          unit: z.string(),
          amount: z.string(),
        }),
      ),
      revenue: z.array(
        z.object({
          unit: z.string(),
          amount: z.string(),
        }),
      ),
      fees: z.array(
        z.object({
          unit: z.string(),
          amount: z.string(),
        }),
      ),
      transactions: z.number(),
    }),
  ),
});

export const getPaymentEarnings = readAuthenticatedEndpointFactory.build({
  method: 'get',
  input: getPaymentEarningsSchemaInput,
  output: getPaymentEarningsSchemaOutput,
  handler: async ({
    input,
    options,
  }: {
    input: z.infer<typeof getPaymentEarningsSchemaInput>;
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
        input.network,
        options.permission,
      );

      const { periodStart, periodEnd } = parseDateRange(
        input.startDate,
        input.endDate,
      );

      const daysDifference = Math.ceil(
        (periodEnd.getTime() - periodStart.getTime()) / (1000 * 60 * 60 * 24),
      );
      const includeMonthlyBreakdown = daysDifference > 60;

      const paymentRequests = await prisma.paymentRequest.findMany({
        where: {
          createdAt: {
            gte: periodStart,
            lte: periodEnd,
          },
          unlockTime: {
            lte: new Date().getTime(),
          },
          onChainState: OnChainState.Withdrawn,
          PaymentSource: {
            network: input.network,
            deletedAt: null,
          },
        },
        include: {
          RequestedFunds: true,
          WithdrawnForSeller: true,
          PaymentSource: true,
        },
      });

      const agentPayments = filterByAgentIdentifier(
        paymentRequests,
        input.agentIdentifier,
      );

      const { earningsMap, revenueMap, feesMap } = aggregateEarnings(
        agentPayments as unknown as TransactionWithFunds[],
        false,
      );

      const totalEarnings = Array.from(earningsMap.entries()).map(
        ([unit, amount]) => ({
          unit: unit === '' ? 'lovelace' : unit,
          amount: amount.toString(),
        }),
      );

      const totalFeesPaid = Array.from(feesMap.entries()).map(
        ([unit, amount]) => ({
          unit: unit === '' ? 'lovelace' : unit,
          amount: amount.toString(),
        }),
      );

      const totalRevenue = Array.from(revenueMap.entries()).map(
        ([unit, amount]) => ({
          unit: unit === '' ? 'lovelace' : unit,
          amount: amount.toString(),
        }),
      );

      const dailyMap = new Map<
        string,
        {
          earnings: Map<string, bigint>;
          revenue: Map<string, bigint>;
          count: number;
        }
      >();

      agentPayments.forEach((payment) => {
        const dateKey = new Date(payment.createdAt).toISOString().split('T')[0];
        if (!dailyMap.has(dateKey)) {
          dailyMap.set(dateKey, {
            earnings: new Map(),
            revenue: new Map(),
            count: 0,
          });
        }
        const dayData = dailyMap.get(dateKey)!;
        dayData.count++;

        payment.RequestedFunds.forEach(
          (fund: { unit: string; amount: bigint }) => {
            const unit = fund.unit || 'lovelace';
            dayData.revenue.set(
              unit,
              (dayData.revenue.get(unit) || BigInt(0)) + fund.amount,
            );
          },
        );

        payment.WithdrawnForSeller.forEach(
          (withdrawn: { unit: string; amount: bigint }) => {
            const unit = withdrawn.unit || 'lovelace';
            dayData.earnings.set(
              unit,
              (dayData.earnings.get(unit) || BigInt(0)) + withdrawn.amount,
            );
          },
        );

        if (
          payment.onChainState === 'Withdrawn' &&
          payment.WithdrawnForSeller.length === 0
        ) {
          payment.RequestedFunds.forEach(
            (fund: { unit: string; amount: bigint }) => {
              const unit = fund.unit || 'lovelace';
              const feeRate = BigInt(payment.PaymentSource.feeRatePermille);
              const estimatedEarnings =
                (fund.amount * (1000n - feeRate)) / 1000n;
              dayData.earnings.set(
                unit,
                (dayData.earnings.get(unit) || BigInt(0)) + estimatedEarnings,
              );
            },
          );
        }
      });

      const dailyEarnings = Array.from(dailyMap.entries())
        .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
        .map(([date, data]) => {
          const earnings = Array.from(data.earnings.entries()).map(
            ([unit, amount]) => ({
              unit: unit === '' ? 'lovelace' : unit,
              amount: amount.toString(),
            }),
          );

          const revenue = Array.from(data.revenue.entries()).map(
            ([unit, amount]) => ({
              unit: unit === '' ? 'lovelace' : unit,
              amount: amount.toString(),
            }),
          );

          const dayFees = new Map<string, bigint>();
          data.revenue.forEach((revAmount, unit) => {
            const earnAmount = data.earnings.get(unit) || BigInt(0);
            const fee = revAmount - earnAmount;
            if (fee > 0) {
              dayFees.set(unit, fee);
            }
          });

          const fees = Array.from(dayFees.entries()).map(([unit, amount]) => ({
            unit: unit === '' ? 'lovelace' : unit,
            amount: amount.toString(),
          }));

          return {
            date,
            earnings,
            revenue,
            fees,
            transactions: data.count,
          };
        });

      let monthlyBreakdown: any[] | undefined = undefined;
      if (includeMonthlyBreakdown) {
        const monthlyMap = new Map<
          string,
          {
            earnings: Map<string, bigint>;
            count: number;
            year: number;
            month: string;
          }
        >();

        dailyEarnings.forEach((day) => {
          const date = new Date(day.date);
          const year = date.getFullYear();
          const month = date.toLocaleString('default', { month: 'long' });
          const key = `${year}-${month}`;

          if (!monthlyMap.has(key)) {
            monthlyMap.set(key, {
              earnings: new Map(),
              count: 0,
              year,
              month,
            });
          }

          const monthData = monthlyMap.get(key)!;
          monthData.count += day.transactions;

          day.earnings.forEach((earning) => {
            const currentAmount =
              monthData.earnings.get(earning.unit) || BigInt(0);
            monthData.earnings.set(
              earning.unit,
              currentAmount + BigInt(earning.amount),
            );
          });
        });

        monthlyBreakdown = Array.from(monthlyMap.values()).map((data) => ({
          month: data.month,
          year: data.year,
          earnings: Array.from(data.earnings.entries()).map(
            ([unit, amount]) => ({
              unit: unit === '' ? 'lovelace' : unit,
              amount: amount.toString(),
            }),
          ),
          transactions: data.count,
        }));
      }

      const startDateString = periodStart.toISOString().split('T')[0];
      const endDateString = periodEnd.toISOString().split('T')[0];

      return {
        agentIdentifier: input.agentIdentifier,
        dateRange: `${startDateString} to ${endDateString}`,
        periodStart,
        periodEnd,
        totalTransactions: agentPayments.length,
        totalEarnings,
        totalFeesPaid,
        totalRevenue,
        dailyEarnings,
        monthlyBreakdown,
      };
    } catch (error: unknown) {
      const errorInstance =
        error instanceof Error ? error : new Error(String(error));
      const statusCode =
        (errorInstance as { statusCode?: number; status?: number })
          .statusCode ||
        (errorInstance as { statusCode?: number; status?: number }).status ||
        500;

      recordBusinessEndpointError(
        '/api/v1/payment/payment-earnings',
        'GET',
        statusCode,
        errorInstance,
        {
          agent_identifier: input.agentIdentifier,
          start_date: input.startDate || 'null',
          end_date: input.endDate || 'null',
          network: input.network,
          user_id: options.id,
          duration: Date.now() - startTime,
        },
      );

      throw error;
    }
  },
});
