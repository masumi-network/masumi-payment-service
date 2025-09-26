import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { z } from 'zod';
import {
  $Enums,
  HotWalletType,
  Network,
  PaymentType,
  PricingType,
  RegistrationState,
  TransactionStatus,
} from '@prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { DEFAULTS } from '@/utils/config';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { recordBusinessEndpointError } from '@/utils/metrics';

export const queryRegistryRequestSchemaInput = z.object({
  cursorId: z
    .string()
    .optional()
    .describe('The cursor id to paginate through the results'),
  network: z
    .nativeEnum(Network)
    .describe('The Cardano network used to register the agent on'),
  filterSmartContractAddress: z
    .string()
    .optional()
    .nullable()
    .describe('The smart contract address of the payment source'),
});

export const queryRegistryRequestSchemaOutput = z.object({
  Assets: z.array(
    z.object({
      error: z.string().nullable(),
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
      agentIdentifier: z.string().min(57).max(250).nullable(),
      AgentPricing: z
        .object({
          pricingType: z.enum([PricingType.Fixed]),
          Pricing: z
            .array(
              z.object({
                amount: z.string(),
                unit: z.string().max(250),
              }),
            )
            .min(1),
        })
        .or(
          z.object({
            pricingType: z.enum([PricingType.Free]),
          }),
        ),
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
  handler: async ({
    input,
    options,
  }: {
    input: z.infer<typeof queryRegistryRequestSchemaInput>;
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

    const result = await prisma.registryRequest.findMany({
      where: {
        PaymentSource: {
          network: input.network,
          deletedAt: null,
          smartContractAddress: input.filterSmartContractAddress ?? undefined,
        },
        SmartContractWallet: { deletedAt: null },
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
        AgentPricing:
          item.Pricing.pricingType == PricingType.Fixed
            ? {
                pricingType: PricingType.Fixed,
                Pricing:
                  item.Pricing.FixedPricing?.Amounts.map((price) => ({
                    unit: price.unit,
                    amount: price.amount.toString(),
                  })) ?? [],
              }
            : {
                pricingType: PricingType.Free,
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
  AgentPricing: z
    .object({
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
    })
    .or(
      z.object({
        pricingType: z.enum([PricingType.Free]),
      }),
    ),
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
  AgentPricing: z
    .object({
      pricingType: z.enum([PricingType.Fixed]),
      Pricing: z.array(
        z.object({
          unit: z.string(),
          amount: z.string(),
        }),
      ),
    })
    .or(
      z.object({
        pricingType: z.enum([PricingType.Free]),
      }),
    ),
});

export const registerAgentPost = payAuthenticatedEndpointFactory.build({
  method: 'post',
  input: registerAgentSchemaInput,
  output: registerAgentSchemaOutput,
  handler: async ({
    input,
    options,
  }: {
    input: z.infer<typeof registerAgentSchemaInput>;
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

      const sellingWallet = await prisma.hotWallet.findUnique({
        where: {
          walletVkey: input.sellingWalletVkey,
          type: HotWalletType.Selling,

          deletedAt: null,
        },
        include: {
          PaymentSource: {
            include: {
              AdminWallets: true,
              HotWallets: {
                include: { Secret: true },
                where: { deletedAt: null },
              },
              PaymentSourceConfig: true,
            },
          },
        },
      });
      if (sellingWallet == null) {
        recordBusinessEndpointError(
          '/api/v1/registry',
          'POST',
          404,
          'Network and Address combination not supported',
          {
            network: input.network,
            operation: 'register_agent',
            step: 'wallet_lookup',
            wallet_vkey: input.sellingWalletVkey,
          },
        );
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

      if (sellingWallet == null) {
        recordBusinessEndpointError(
          '/api/v1/registry',
          'POST',
          404,
          'Selling wallet not found',
          {
            network: input.network,
            operation: 'register_agent',
            step: 'wallet_validation',
            wallet_vkey: input.sellingWalletVkey,
          },
        );
        throw createHttpError(404, 'Selling wallet not found');
      }
      const paymentSource = sellingWallet.PaymentSource;
      if (paymentSource == null) {
        recordBusinessEndpointError(
          '/api/v1/registry',
          'POST',
          404,
          'Selling wallet has no payment source',
          {
            network: input.network,
            operation: 'register_agent',
            step: 'payment_source_validation',
            wallet_id: sellingWallet.id,
          },
        );
        throw createHttpError(404, 'Selling wallet has no payment source');
      }
      if (paymentSource.network != input.network) {
        recordBusinessEndpointError(
          '/api/v1/registry',
          'POST',
          400,
          'Selling wallet is not on the requested network',
          {
            network: input.network,
            operation: 'register_agent',
            step: 'network_validation',
            wallet_network: paymentSource.network,
            requested_network: input.network,
          },
        );
        throw createHttpError(
          400,
          'Selling wallet is not on the requested network',
        );
      }
      if (paymentSource.deletedAt != null) {
        recordBusinessEndpointError(
          '/api/v1/registry',
          'POST',
          400,
          'Payment source is deleted',
          {
            network: input.network,
            operation: 'register_agent',
            step: 'payment_source_validation',
            payment_source_id: paymentSource.id,
          },
        );
        throw createHttpError(400, 'Payment source is deleted');
      }
      const result = await prisma.registryRequest.create({
        data: {
          name: input.name,
          description: input.description,
          apiBaseUrl: input.apiBaseUrl,
          capabilityName: input.Capability.name,
          capabilityVersion: input.Capability.version,
          other: input.Legal?.other,
          terms: input.Legal?.terms,
          privacyPolicy: input.Legal?.privacyPolicy,
          authorName: input.Author.name,
          paymentType:
            input.AgentPricing.pricingType == PricingType.Fixed
              ? PaymentType.None
              : PaymentType.Web3CardanoV1,
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
            create:
              input.AgentPricing.pricingType == PricingType.Fixed
                ? {
                    pricingType: input.AgentPricing.pricingType,
                    FixedPricing: {
                      create: {
                        Amounts: {
                          createMany: {
                            data: input.AgentPricing.Pricing.map((price) => ({
                              unit:
                                price.unit.toLowerCase() == 'lovelace'
                                  ? ''
                                  : price.unit,
                              amount: BigInt(price.amount),
                            })),
                          },
                        },
                      },
                    },
                  }
                : {
                    pricingType: input.AgentPricing.pricingType,
                  },
          },
        },
        include: {
          Pricing: {
            include: { FixedPricing: { include: { Amounts: true } } },
          },
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
        AgentPricing:
          input.AgentPricing.pricingType == PricingType.Fixed
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
        Tags: result.tags,
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
        '/api/v1/registry',
        'POST',
        statusCode,
        errorInstance,
        {
          network: input.network,
          user_id: options.id,
          agent_name: input.name,
          operation: 'register_agent',
          duration: Date.now() - startTime,
        },
      );

      throw error;
    }
  },
});

export const deleteAgentRegistrationSchemaInput = z.object({
  id: z
    .string()
    .cuid()
    .describe(
      'The database ID of the agent registration record to be deleted.',
    ),
});

export const deleteAgentRegistrationSchemaOutput = z.object({
  id: z.string(),
});

export const deleteAgentRegistration = adminAuthenticatedEndpointFactory.build({
  method: 'delete',
  input: deleteAgentRegistrationSchemaInput,
  output: deleteAgentRegistrationSchemaOutput,
  handler: async ({ input }) => {
    const startTime = Date.now();
    try {
      const registryRequest = await prisma.registryRequest.findUnique({
        where: {
          id: input.id,
        },
        include: {
          PaymentSource: true,
        },
      });

      if (!registryRequest) {
        recordBusinessEndpointError(
          '/api/v1/registry',
          'DELETE',
          404,
          'Agent Registration not found',
          {
            registry_id: input.id,
            operation: 'delete_agent_registration',
            step: 'registry_lookup',
          },
        );
        throw createHttpError(404, 'Agent Registration not found');
      }

      const validStatesForDeletion: RegistrationState[] = [
        RegistrationState.RegistrationFailed,
        RegistrationState.DeregistrationConfirmed,
      ];

      if (!validStatesForDeletion.includes(registryRequest.state)) {
        recordBusinessEndpointError(
          '/api/v1/registry',
          'DELETE',
          400,
          `Agent registration cannot be deleted in its current state: ${registryRequest.state}`,
          {
            registry_id: input.id,
            operation: 'delete_agent_registration',
            step: 'state_validation',
            current_state: registryRequest.state,
            valid_states: validStatesForDeletion.join(', '),
          },
        );
        throw createHttpError(
          400,
          `Agent registration cannot be deleted in its current state: ${registryRequest.state}`,
        );
      }

      await prisma.registryRequest.delete({
        where: {
          id: registryRequest.id,
        },
      });

      return {
        id: registryRequest.id,
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
        '/api/v1/registry',
        'DELETE',
        statusCode,
        errorInstance,
        {
          registry_id: input.id,
          operation: 'delete_agent_registration',
          duration: Date.now() - startTime,
        },
      );

      throw error;
    }
  },
});
