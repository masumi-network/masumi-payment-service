import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { z } from 'zod';
import {
  HotWalletType,
  Network,
  PricingType,
  RegistrationState,
  TransactionStatus,
} from '@prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { resolvePaymentKeyHash } from '@meshsdk/core-cst';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { getRegistryScriptFromNetworkHandlerV1 } from '@/utils/generator/contract-generator';
import { DEFAULTS } from '@/utils/config';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';

export const queryRegistryRequestSchemaInput = z.object({
  cursorId: z
    .string()
    .optional()
    .describe('The cursor id to paginate through the results'),
  network: z
    .nativeEnum(Network)
    .describe('The Cardano network used to register the agent on'),
  smartContractAddress: z
    .string()
    .max(250)
    .optional()
    .describe(
      'The smart contract address of the payment source to which the registration belongs',
    ),
});

export const queryRegistryRequestSchemaOutput = z.object({
  Assets: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable(),
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
      state: z.nativeEnum(RegistrationState),
      Tags: z.array(z.string()),
      createdAt: z.date(),
      updatedAt: z.date(),
      lastCheckedAt: z.date().nullable(),
      ExampleOutputs: z
        .array(
          z.object({
            name: z.string().max(60),
            url: z.string().max(250),
            mimeType: z.string().max(60),
          }),
        )
        .max(25),
      agentIdentifier: z.string().nullable(),
      AgentPricing: z.object({
        pricingType: z.enum([PricingType.Fixed]),
        Pricing: z
          .array(
            z.object({
              amount: z.string(),
              unit: z.string().max(250),
            }),
          )
          .min(1),
      }),
      SmartContractWallet: z.object({
        walletVkey: z.string(),
        walletAddress: z.string(),
      }),
      CurrentTransaction: z
        .object({
          txHash: z.string(),
          status: z.nativeEnum(TransactionStatus),
        })
        .nullable(),
    }),
  ),
});

export const queryRegistryRequestGet = payAuthenticatedEndpointFactory.build({
  method: 'get',
  input: queryRegistryRequestSchemaInput,
  output: queryRegistryRequestSchemaOutput,
  handler: async ({ input, options }) => {
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
      },
      include: { PaymentSourceConfig: true, HotWallets: true },
    });
    if (paymentSource == null) {
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

    const result = await prisma.registryRequest.findMany({
      where: {
        PaymentSource: {
          id: paymentSource.id,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      take: 10,
      cursor: input.cursorId ? { id: input.cursorId } : undefined,
      include: {
        SmartContractWallet: true,
        CurrentTransaction: true,
        Pricing: { include: { FixedPricing: { include: { Amounts: true } } } },
        ExampleOutputs: true,
      },
    });

    return {
      Assets: result.map((item) => ({
        ...item,
        Capability: {
          name: item.capabilityName,
          version: item.capabilityVersion,
        },
        Author: {
          name: item.authorName,
          contactEmail: item.authorContactEmail,
          contactOther: item.authorContactOther,
          organization: item.authorOrganization,
        },
        Legal: {
          privacyPolicy: item.privacyPolicy,
          terms: item.terms,
          other: item.other,
        },
        AgentPricing: {
          pricingType: PricingType.Fixed,
          Pricing:
            item.Pricing.FixedPricing?.Amounts.map((price) => ({
              unit: price.unit,
              amount: price.amount.toString(),
            })) ?? [],
        },
        Tags: item.tags,
      })),
    };
  },
});

export const registerAgentSchemaInput = z.object({
  network: z
    .nativeEnum(Network)
    .describe('The Cardano network used to register the agent on'),
  smartContractAddress: z
    .string()
    .max(250)
    .optional()
    .describe(
      'The smart contract address of the payment contract to be registered for',
    ),
  sellingWalletVkey: z
    .string()
    .max(250)
    .describe('The payment key of a specific wallet used for the registration'),
  ExampleOutputs: z
    .array(
      z.object({
        name: z.string().max(60),
        url: z.string().max(250),
        mimeType: z.string().max(60),
      }),
    )
    .max(25),
  Tags: z
    .array(z.string().max(63))
    .min(1)
    .max(15)
    .describe('Tags used in the registry metadata'),
  name: z.string().max(250).describe('Name of the agent'),
  apiBaseUrl: z
    .string()
    .max(250)
    .describe('Base URL of the agent, to request interactions'),
  description: z.string().max(250).describe('Description of the agent'),
  Capability: z
    .object({ name: z.string().max(250), version: z.string().max(250) })
    .describe('Provide information about the used AI model and version'),
  AgentPricing: z.object({
    pricingType: z.enum([PricingType.Fixed]),
    Pricing: z
      .array(
        z.object({
          unit: z.string().max(250),
          amount: z.string().max(25),
        }),
      )
      .min(1)
      .max(5)
      .describe('Price for a default interaction'),
  }),
  Legal: z
    .object({
      privacyPolicy: z.string().max(250).optional(),
      terms: z.string().max(250).optional(),
      other: z.string().max(250).optional(),
    })
    .optional()
    .describe('Legal information about the agent'),
  Author: z
    .object({
      name: z.string().max(250),
      contactEmail: z.string().max(250).optional(),
      contactOther: z.string().max(250).optional(),
      organization: z.string().max(250).optional(),
    })
    .describe('Author information about the agent'),
});

export const registerAgentSchemaOutput = z.object({
  id: z.string(),
  name: z.string(),
  apiBaseUrl: z.string(),
  Capability: z.object({
    name: z.string().nullable(),
    version: z.string().nullable(),
  }),
  Legal: z.object({
    privacyPolicy: z.string().nullable(),
    terms: z.string().nullable(),
    other: z.string().nullable(),
  }),
  Author: z.object({
    name: z.string(),
    contactEmail: z.string().nullable(),
    contactOther: z.string().nullable(),
    organization: z.string().nullable(),
  }),
  description: z.string().nullable(),
  Tags: z.array(z.string()),
  state: z.nativeEnum(RegistrationState),
  SmartContractWallet: z.object({
    walletVkey: z.string(),
    walletAddress: z.string(),
  }),
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

export const registerAgentPost = payAuthenticatedEndpointFactory.build({
  method: 'post',
  input: registerAgentSchemaInput,
  output: registerAgentSchemaOutput,
  handler: async ({ input, options }) => {
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
      },
      include: {
        AdminWallets: true,
        HotWallets: { include: { Secret: true } },
        PaymentSourceConfig: true,
      },
    });
    if (paymentSource == null) {
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

    const sellingWallet = paymentSource.HotWallets.find(
      (wallet) =>
        wallet.walletVkey == input.sellingWalletVkey &&
        wallet.type == HotWalletType.Selling,
    );
    if (sellingWallet == null) {
      throw createHttpError(404, 'Selling wallet not found');
    }
    const result = await prisma.registryRequest.create({
      data: {
        name: input.name,
        description: input.description,
        apiBaseUrl: input.apiBaseUrl,
        capabilityName: input.Capability.name,
        capabilityVersion: input.Capability.version,
        authorName: input.Author.name,
        authorContactEmail: input.Author.contactEmail,
        authorContactOther: input.Author.contactOther,
        authorOrganization: input.Author.organization,
        state: RegistrationState.RegistrationRequested,
        agentIdentifier: null,
        metadataVersion: DEFAULTS.DEFAULT_METADATA_VERSION,
        ExampleOutputs: {
          createMany: {
            data: input.ExampleOutputs.map((exampleOutput) => ({
              name: exampleOutput.name,
              url: exampleOutput.url,
              mimeType: exampleOutput.mimeType,
            })),
          },
        },
        SmartContractWallet: {
          connect: {
            id: sellingWallet.id,
          },
        },
        PaymentSource: {
          connect: {
            id: paymentSource.id,
          },
        },
        tags: input.Tags,
        Pricing: {
          create: {
            pricingType: input.AgentPricing.pricingType,
            FixedPricing: {
              create: {
                Amounts: {
                  createMany: {
                    data: input.AgentPricing.Pricing.map((price) => ({
                      unit: price.unit,
                      amount: BigInt(price.amount),
                    })),
                  },
                },
              },
            },
          },
        },
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
      Legal: {
        privacyPolicy: result.privacyPolicy,
        terms: result.terms,
        other: result.other,
      },
      Author: {
        name: result.authorName,
        contactEmail: result.authorContactEmail,
        contactOther: result.authorContactOther,
        organization: result.authorOrganization,
      },
      AgentPricing: {
        pricingType: PricingType.Fixed,
        Pricing:
          result.Pricing.FixedPricing?.Amounts.map((pricing) => ({
            unit: pricing.unit,
            amount: pricing.amount.toString(),
          })) ?? [],
      },
      Tags: result.tags,
    };
  },
});

export const unregisterAgentSchemaInput = z.object({
  agentIdentifier: z
    .string()
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

export const unregisterAgentDelete = payAuthenticatedEndpointFactory.build({
  method: 'delete',
  input: unregisterAgentSchemaInput,
  output: unregisterAgentSchemaOutput,
  handler: async ({ input, options }) => {
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
      },
      include: {
        PaymentSourceConfig: true,
        HotWallets: { include: { Secret: true } },
      },
    });
    if (paymentSource == null) {
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
      where: { id: registryRequest.id },
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
