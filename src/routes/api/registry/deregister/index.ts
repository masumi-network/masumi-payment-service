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
import { extractAssetName } from '@/utils/converter/agent-identifier';

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
  id: z.string().describe('Unique identifier for the registry request'),
  name: z.string().describe('Name of the agent'),
  apiBaseUrl: z.string().describe('Base URL of the agent API for interactions'),
  Capability: z
    .object({
      name: z
        .string()
        .nullable()
        .describe('Name of the AI model/capability. Null if not provided'),
      version: z
        .string()
        .nullable()
        .describe('Version of the AI model/capability. Null if not provided'),
    })
    .describe('Information about the AI model and version used by the agent'),
  Author: z
    .object({
      name: z.string().describe('Name of the agent author'),
      contactEmail: z
        .string()
        .nullable()
        .describe('Contact email of the author. Null if not provided'),
      contactOther: z
        .string()
        .nullable()
        .describe(
          'Other contact information for the author. Null if not provided',
        ),
      organization: z
        .string()
        .nullable()
        .describe('Organization of the author. Null if not provided'),
    })
    .describe('Author information for the agent'),
  Legal: z
    .object({
      privacyPolicy: z
        .string()
        .nullable()
        .describe('URL to the privacy policy. Null if not provided'),
      terms: z
        .string()
        .nullable()
        .describe('URL to the terms of service. Null if not provided'),
      other: z
        .string()
        .nullable()
        .describe('Other legal information. Null if not provided'),
    })
    .describe('Legal information about the agent'),
  description: z
    .string()
    .nullable()
    .describe('Description of the agent. Null if not provided'),
  Tags: z.array(z.string()).describe('List of tags categorizing the agent'),
  SmartContractWallet: z
    .object({
      walletVkey: z
        .string()
        .describe('Payment key hash of the smart contract wallet'),
      walletAddress: z
        .string()
        .describe('Cardano address of the smart contract wallet'),
    })
    .describe('Smart contract wallet managing this agent registration'),
  state: z
    .nativeEnum(RegistrationState)
    .describe(
      'Current state of the registration process (should be DeregistrationRequested)',
    ),
  ExampleOutputs: z
    .array(
      z.object({
        name: z.string().max(60).describe('Name of the example output'),
        url: z.string().max(250).describe('URL to the example output'),
        mimeType: z
          .string()
          .max(60)
          .describe(
            'MIME type of the example output (e.g., image/png, text/plain)',
          ),
      }),
    )
    .max(25)
    .describe('List of example outputs from the agent'),
  AgentPricing: z
    .object({
      pricingType: z
        .enum([PricingType.Fixed])
        .describe('Pricing type for the agent (Fixed or Free)'),
      Pricing: z
        .array(
          z.object({
            unit: z
              .string()
              .describe(
                'Asset policy id + asset name concatenated. Empty string for ADA/lovelace',
              ),
            amount: z
              .string()
              .describe(
                'Amount of the asset in smallest unit (e.g., lovelace for ADA)',
              ),
          }),
        )
        .describe('List of assets and amounts for fixed pricing'),
    })
    .or(
      z.object({
        pricingType: z
          .enum([PricingType.Free])
          .describe('Pricing type for the agent (Fixed or Free)'),
      }),
    )
    .describe('Pricing information for the agent'),
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

    const assetName = extractAssetName(input.agentIdentifier);
    const holderWallet = await blockfrost.assetsAddresses(
      policyId + assetName,
      {
        order: 'desc',
        count: 1,
      },
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
      AgentPricing:
        result.Pricing.pricingType == PricingType.Fixed
          ? {
              pricingType: PricingType.Fixed,
              Pricing:
                result.Pricing.FixedPricing?.Amounts.map((pricing) => ({
                  unit: pricing.unit,
                  amount: pricing.amount.toString(),
                })) ?? [],
            }
          : {
              pricingType: PricingType.Free,
            },
    };
  },
});
