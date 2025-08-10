import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { z } from 'zod';
import {
  $Enums,
  HotWalletType,
  Network,
  PricingType,
  RegistrationState,
} from '@prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { resolvePaymentKeyHash } from '@meshsdk/core-cst';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { getRegistryScriptFromNetworkHandlerV1 } from '@/utils/generator/contract-generator';
import { DEFAULTS } from '@/utils/config';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';

export const unregisterAgentSchemaInput = z.object({
  agentIdentifier: z
    .string()
    .min(57)
    .max(250)
    .describe('The identifier of the registration (asset) to be deregistered'),
  network: z
    .nativeEnum(Network)
    .describe('The network the registration was made on'),
  smartContractAddress: z
    .string()
    .max(250)
    .optional()
    .describe(
      'The smart contract address of the payment contract to which the registration belongs',
    ),
});

export const unregisterAgentSchemaOutput = z.object({
  id: z.string(),
  name: z.string(),
  apiBaseUrl: z.string(),
  Capability: z.object({
    name: z.string().nullable(),
    version: z.string().nullable(),
  }),
  Author: z.object({
    name: z.string(),
    contactEmail: z.string().nullable(),
    contactOther: z.string().nullable(),
    organization: z.string().nullable(),
  }),
  Legal: z.object({
    privacyPolicy: z.string().nullable(),
    terms: z.string().nullable(),
    other: z.string().nullable(),
  }),
  description: z.string().nullable(),
  Tags: z.array(z.string()),
  SmartContractWallet: z.object({
    walletVkey: z.string(),
    walletAddress: z.string(),
  }),
  state: z.nativeEnum(RegistrationState),
  ExampleOutputs: z
    .array(
      z.object({
        name: z.string().max(60),
        url: z.string().max(250),
        mimeType: z.string().max(60),
      }),
    )
    .max(25),
  AgentPricing: z.object({
    pricingType: z.enum([PricingType.Fixed]),
    Pricing: z.array(
      z.object({
        unit: z.string(),
        amount: z.string(),
      }),
    ),
  }),
});

export const unregisterAgentPost = payAuthenticatedEndpointFactory.build({
  method: 'post',
  input: unregisterAgentSchemaInput,
  output: unregisterAgentSchemaOutput,
  handler: async ({
    input,
    options,
  }: {
    input: z.infer<typeof unregisterAgentSchemaInput>;
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
    const smartContractAddress =
      input.smartContractAddress ??
      (input.network == Network.Mainnet
        ? DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_MAINNET
        : DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_PREPROD);
    const paymentSource = await prisma.paymentSource.findUnique({
      where: {
        network_smartContractAddress: {
          network: input.network,
          smartContractAddress: smartContractAddress,
        },
        deletedAt: null,
      },
      include: {
        PaymentSourceConfig: true,
        HotWallets: { include: { Secret: true }, where: { deletedAt: null } },
      },
    });
    if (paymentSource == null) {
      throw createHttpError(
        404,
        'Network and Address combination not supported',
      );
    }

    const blockfrost = new BlockFrostAPI({
      projectId: paymentSource.PaymentSourceConfig.rpcProviderApiKey,
    });

    const { policyId } =
      await getRegistryScriptFromNetworkHandlerV1(paymentSource);

    let assetName = input.agentIdentifier;
    if (assetName.startsWith(policyId)) {
      assetName = assetName.slice(policyId.length);
    }
    const holderWallet = await blockfrost.assetsAddresses(
      policyId + assetName,
      { order: 'desc', count: 1 },
    );
    if (holderWallet.length == 0) {
      throw createHttpError(404, 'Asset not found');
    }
    const vkey = resolvePaymentKeyHash(holderWallet[0].address);

    const sellingWallet = paymentSource.HotWallets.find(
      (wallet) =>
        wallet.walletVkey == vkey && wallet.type == HotWalletType.Selling,
    );
    if (sellingWallet == null) {
      throw createHttpError(404, 'Registered Wallet not found');
    }
    const registryRequest = await prisma.registryRequest.findUnique({
      where: {
        agentIdentifier: policyId + assetName,
      },
    });
    if (registryRequest == null) {
      throw createHttpError(404, 'Registration not found');
    }
    const result = await prisma.registryRequest.update({
      where: {
        id: registryRequest.id,
        SmartContractWallet: {
          deletedAt: null,
        },
      },
      data: {
        state: RegistrationState.DeregistrationRequested,
      },
      include: {
        Pricing: { include: { FixedPricing: { include: { Amounts: true } } } },
        SmartContractWallet: true,
        ExampleOutputs: true,
      },
    });

    return {
      ...result,
      Capability: {
        name: result.capabilityName,
        version: result.capabilityVersion,
      },
      Author: {
        name: result.authorName,
        contactEmail: result.authorContactEmail,
        contactOther: result.authorContactOther,
        organization: result.authorOrganization,
      },
      Legal: {
        privacyPolicy: result.privacyPolicy,
        terms: result.terms,
        other: result.other,
      },
      Tags: result.tags,
      AgentPricing: {
        pricingType: PricingType.Fixed,
        Pricing:
          result.Pricing.FixedPricing?.Amounts.map((pricing) => ({
            unit: pricing.unit,
            amount: pricing.amount.toString(),
          })) ?? [],
      },
    };
  },
});
