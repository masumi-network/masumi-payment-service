import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import { z } from 'zod';
import {
  HotWalletType,
  Network,
  OnChainState,
  PaymentAction,
  PaymentErrorType,
  PaymentType,
} from '@prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { ez } from 'express-zod-api';
import cuid2 from '@paralleldrive/cuid2';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { MeshWallet, resolvePaymentKeyHash } from '@meshsdk/core';
import { getRegistryScriptV1 } from '@/utils/generator/contract-generator';
import { DEFAULTS } from '@/utils/config';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { convertNetworkToId } from '@/utils/converter/network-convert';
import { decrypt } from '@/utils/security/encryption';

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
  smartContractAddress: z
    .string()
    .max(250)
    .optional()
    .describe(
      'The address of the smart contract where the payments were made to',
    ),
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
      submitResultTime: z.string(),
      unlockTime: z.string(),
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
    }),
  ),
});

export const queryPaymentEntryGet = readAuthenticatedEndpointFactory.build({
  method: 'get',
  input: queryPaymentsSchemaInput,
  output: queryPaymentsSchemaOutput,
  handler: async ({ input, options }) => {
    const paymentSourceAddress =
      input.smartContractAddress ??
      (input.network == Network.Mainnet
        ? DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_MAINNET
        : DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_PREPROD);
    const paymentSource = await prisma.paymentSource.findUnique({
      where: {
        network_smartContractAddress: {
          network: input.network,
          smartContractAddress: paymentSourceAddress,
        },
      },
      include: {
        HotWallets: true,
        PaymentSourceConfig: true,
      },
    });
    if (!paymentSource) {
      throw createHttpError(404, 'Payment source not found');
    }

    await checkIsAllowedNetworkOrThrowUnauthorized(
      options.networkLimit,
      input.network,
      options.permission,
    );

    const result = await prisma.paymentRequest.findMany({
      where: { paymentSourceId: paymentSource.id },
      orderBy: { createdAt: 'desc' },
      cursor: input.cursorId
        ? {
            id: input.cursorId,
          }
        : undefined,
      take: input.limit,
      include: {
        BuyerWallet: true,
        SmartContractWallet: true,
        PaymentSource: true,
        RequestedFunds: { include: { AgentFixedPricing: true } },
        NextAction: true,
        CurrentTransaction: true,
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
        unlockTime: payment.unlockTime.toString(),
        externalDisputeUnlockTime: payment.externalDisputeUnlockTime.toString(),
        RequestedFunds: payment.RequestedFunds.map((amount) => ({
          ...amount,
          amount: amount.amount.toString(),
        })),
      })),
    };
  },
});

export const createPaymentsSchemaInput = z.object({
  inputHash: z.string().max(250),
  network: z
    .nativeEnum(Network)
    .describe('The network the payment will be received on'),
  agentIdentifier: z
    .string()
    .min(15)
    .max(250)
    .describe('The identifier of the agent that will be paid'),
  RequestedFunds: z
    .array(z.object({ amount: z.string().max(25), unit: z.string().max(150) }))
    .max(7)
    .describe('The amounts of the payment'),
  paymentType: z
    .nativeEnum(PaymentType)
    .describe('The type of payment contract used'),
  smartContractAddress: z
    .string()
    .max(250)
    .optional()
    .describe(
      'The address of the smart contract where the payment will be made to',
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
    .min(15)
    .max(25)
    .describe('The cuid2 identifier of the purchaser of the payment'),
});

export const createPaymentSchemaOutput = z.object({
  id: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
  blockchainIdentifier: z.string(),
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

export const paymentInitPost = readAuthenticatedEndpointFactory.build({
  method: 'post',
  input: createPaymentsSchemaInput,
  output: createPaymentSchemaOutput,
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
        HotWallets: { include: { Secret: true } },
        PaymentSourceConfig: true,
      },
    });
    if (specifiedPaymentContract == null) {
      throw createHttpError(
        404,
        'Network and Address combination not supported',
      );
    }
    await checkIsAllowedNetworkOrThrowUnauthorized(
      options.networkLimit,
      input.network,
      options.permission,
    );

    const unlockTime =
      input.unlockTime != undefined
        ? input.unlockTime.getTime()
        : new Date(
            input.submitResultTime.getTime() + 1000 * 60 * 60 * 6,
          ).getTime(); // 6h
    const externalDisputeUnlockTime =
      input.externalDisputeUnlockTime != undefined
        ? input.externalDisputeUnlockTime.getTime()
        : new Date(
            input.submitResultTime.getTime() + 1000 * 60 * 60 * 12,
          ).getTime(); // 12h

    const provider = new BlockFrostAPI({
      projectId: specifiedPaymentContract.PaymentSourceConfig.rpcProviderApiKey,
    });
    const { policyId } = await getRegistryScriptV1(
      smartContractAddress,
      input.network,
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
    const blockchainIdentifier = {
      inputHash: input.inputHash,
      agentIdentifier: input.agentIdentifier,
      purchaserIdentifier: input.identifierFromPurchaser,
      sellerAddress: sellingWallet.walletAddress,
      sellerIdentifier: cuid2.createId(),
      RequestedFunds: input.RequestedFunds.map((amount) => ({
        amount: amount.amount,
        unit: amount.unit,
      })),
      submitResultTime: input.submitResultTime.getTime().toString(),
      unlockTime: unlockTime.toString(),
      externalDisputeUnlockTime: externalDisputeUnlockTime.toString(),
    };
    const meshWallet = new MeshWallet({
      networkId: convertNetworkToId(input.network),
      key: {
        type: 'mnemonic',
        words: decrypt(sellingWallet.Secret.encryptedMnemonic).split(' '),
      },
    });

    const encodedBlockchainIdentifier = JSON.stringify(blockchainIdentifier);
    const signedBlockchainIdentifier = await meshWallet.signData(
      encodedBlockchainIdentifier,
      sellingWallet.walletAddress,
    );
    const signedEncodedBlockchainIdentifier = Buffer.from(
      JSON.stringify({
        data: encodedBlockchainIdentifier,
        signature: signedBlockchainIdentifier.signature,
        key: signedBlockchainIdentifier.key,
      }),
    ).toString('base64');

    const payment = await prisma.paymentRequest.create({
      data: {
        blockchainIdentifier: signedEncodedBlockchainIdentifier,
        PaymentSource: { connect: { id: specifiedPaymentContract.id } },
        RequestedFunds: {
          createMany: {
            data: input.RequestedFunds.map((amount) => {
              if (amount.unit == '') {
                return { amount: BigInt(amount.amount), unit: 'lovelace' };
              } else {
                return { amount: BigInt(amount.amount), unit: amount.unit };
              }
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
        SmartContractWallet: { connect: { id: sellingWallet.id } },
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
        SmartContractWallet: true,
        PaymentSource: true,
        NextAction: true,
        CurrentTransaction: true,
        TransactionHistory: true,
      },
    });
    if (payment.SmartContractWallet == null) {
      throw createHttpError(500, 'Smart contract wallet not connected');
    }
    return {
      ...payment,
      submitResultTime: payment.submitResultTime.toString(),
      unlockTime: payment.unlockTime.toString(),
      externalDisputeUnlockTime: payment.externalDisputeUnlockTime.toString(),
      RequestedFunds: payment.RequestedFunds.map((amount) => ({
        ...amount,
        amount: amount.amount.toString(),
      })),
    };
  },
});
