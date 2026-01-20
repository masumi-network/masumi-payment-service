import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { z } from '@/utils/zod-openapi';
import {
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
import {
  AuthContext,
  checkIsAllowedNetworkOrThrowUnauthorized,
} from '@/utils/middleware/auth-middleware';
import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { recordBusinessEndpointError } from '@/utils/metrics';
import {
  getBlockfrostInstance,
  validateAssetsOnChain,
} from '@/utils/blockfrost';

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

export const registryRequestOutputSchema = z
  .object({
    error: z
      .string()
      .nullable()
      .describe('Error message if registration failed. Null if no error'),
    id: z.string().describe('Unique identifier for the registry request'),
    name: z.string().describe('Name of the agent'),
    description: z
      .string()
      .nullable()
      .describe('Description of the agent. Null if not provided'),
    apiBaseUrl: z
      .string()
      .describe('Base URL of the agent API for interactions'),
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
    state: z
      .nativeEnum(RegistrationState)
      .describe('Current state of the registration process'),
    Tags: z.array(z.string()).describe('List of tags categorizing the agent'),
    createdAt: z
      .date()
      .describe('Timestamp when the registry request was created'),
    updatedAt: z
      .date()
      .describe('Timestamp when the registry request was last updated'),
    lastCheckedAt: z
      .date()
      .nullable()
      .describe(
        'Timestamp when the registry was last checked. Null if never checked',
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
    agentIdentifier: z
      .string()
      .min(57)
      .max(250)
      .nullable()
      .describe(
        'Full agent identifier (policy ID + asset name). Null if not yet minted',
      ),
    AgentPricing: z
      .object({
        pricingType: z
          .enum([PricingType.Fixed])
          .describe('Pricing type for the agent '),
        Pricing: z
          .array(
            z.object({
              amount: z
                .string()
                .describe(
                  'The quantity of the asset. Make sure to convert it from the underlying smallest unit (in case of decimals, multiply it by the decimal factor e.g. for 1 ADA = 10000000 lovelace)',
                ),
              unit: z
                .string()
                .max(250)
                .describe(
                  'Asset policy id + asset name concatenated. Uses an empty string for ADA/lovelace e.g (1000000 lovelace = 1 ADA)',
                ),
            }),
          )
          .min(1)
          .describe('List of assets and amounts for fixed pricing'),
      })
      .or(
        z.object({
          pricingType: z
            .enum([PricingType.Free])
            .describe('Pricing type for the agent '),
        }),
      )
      .describe('Pricing information for the agent'),
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
    CurrentTransaction: z
      .object({
        txHash: z.string().nullable().describe('Cardano transaction hash'),
        status: z
          .nativeEnum(TransactionStatus)
          .describe('Current status of the transaction'),
        confirmations: z
          .number()
          .nullable()
          .describe(
            'Number of block confirmations for this transaction. Null if not yet confirmed',
          ),
        fees: z.string().nullable().describe('Fees of the transaction'),
        blockHeight: z
          .number()
          .nullable()
          .describe('Block height of the transaction'),
        blockTime: z
          .number()
          .nullable()
          .describe('Block time of the transaction'),
      })
      .nullable(),
  })
  .openapi('RegistryEntry');

export const queryRegistryRequestSchemaOutput = z.object({
  Assets: z.array(registryRequestOutputSchema),
});

export const queryRegistryRequestGet = payAuthenticatedEndpointFactory.build({
  method: 'get',
  input: queryRegistryRequestSchemaInput,
  output: queryRegistryRequestSchemaOutput,
  handler: async ({
    input,
    ctx,
  }: {
    input: z.infer<typeof queryRegistryRequestSchemaInput>;
    ctx: AuthContext;
  }) => {
    await checkIsAllowedNetworkOrThrowUnauthorized(
      ctx.networkLimit,
      input.network,
      ctx.permission,
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
        SmartContractWallet: {
          select: { walletVkey: true, walletAddress: true },
        },
        CurrentTransaction: {
          select: {
            txHash: true,
            status: true,
            confirmations: true,
            fees: true,
            blockHeight: true,
            blockTime: true,
          },
        },
        Pricing: {
          include: {
            FixedPricing: {
              include: { Amounts: { select: { unit: true, amount: true } } },
            },
          },
        },
        ExampleOutputs: {
          select: {
            name: true,
            url: true,
            mimeType: true,
          },
        },
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
        CurrentTransaction: item.CurrentTransaction
          ? {
              ...item.CurrentTransaction,
              fees: item.CurrentTransaction.fees?.toString() ?? null,
            }
          : null,
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
    .object({
      name: z.string().max(250).describe('Name of the AI model/capability'),
      version: z
        .string()
        .max(250)
        .describe('Version of the AI model/capability'),
    })
    .describe('Provide information about the used AI model and version'),
  AgentPricing: z
    .object({
      pricingType: z
        .enum([PricingType.Fixed])
        .describe('Pricing type for the agent '),
      Pricing: z
        .array(
          z.object({
            unit: z
              .string()
              .max(250)
              .describe(
                'Asset policy id + asset name concatenated. Uses an empty string for ADA/lovelace e.g (1000000 lovelace = 1 ADA)',
              ),
            amount: z
              .string()
              .max(25)
              .describe(
                'The quantity of the asset. Make sure to convert it from the underlying smallest unit (in case of decimals, multiply it by the decimal factor e.g. for 1 ADA = 10000000 lovelace)',
              ),
          }),
        )
        .min(1)
        .max(5)
        .describe('Price for a default interaction'),
    })
    .or(
      z.object({
        pricingType: z
          .enum([PricingType.Free])
          .describe('Pricing type for the agent '),
      }),
    )
    .describe('Pricing information for the agent'),
  Legal: z
    .object({
      privacyPolicy: z
        .string()
        .max(250)
        .optional()
        .describe('URL to the privacy policy'),
      terms: z
        .string()
        .max(250)
        .optional()
        .describe('URL to the terms of service'),
      other: z.string().max(250).optional().describe('Other legal information'),
    })
    .optional()
    .describe('Legal information about the agent'),
  Author: z
    .object({
      name: z.string().max(250).describe('Name of the agent author'),
      contactEmail: z
        .string()
        .max(250)
        .optional()
        .describe('Contact email of the author'),
      contactOther: z
        .string()
        .max(250)
        .optional()
        .describe('Other contact information for the author'),
      organization: z
        .string()
        .max(250)
        .optional()
        .describe('Organization of the author'),
    })
    .describe('Author information about the agent'),
});

export const registerAgentSchemaOutput = registryRequestOutputSchema;

export const registerAgentPost = payAuthenticatedEndpointFactory.build({
  method: 'post',
  input: registerAgentSchemaInput,
  output: registerAgentSchemaOutput,
  handler: async ({
    input,
    ctx,
  }: {
    input: z.infer<typeof registerAgentSchemaInput>;
    ctx: AuthContext;
  }) => {
    const startTime = Date.now();
    try {
      await checkIsAllowedNetworkOrThrowUnauthorized(
        ctx.networkLimit,
        input.network,
        ctx.permission,
      );

      const sellingWallet = await prisma.hotWallet.findUnique({
        where: {
          walletVkey: input.sellingWalletVkey,
          type: HotWalletType.Selling,
          deletedAt: null,
          PaymentSource: {
            deletedAt: null,
            network: input.network,
          },
        },
        include: {
          PaymentSource: {
            include: {
              PaymentSourceConfig: {
                select: { rpcProviderApiKey: true },
              },
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
        ctx.networkLimit,
        input.network,
        ctx.permission,
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

      // Validate pricing assets exist on-chain
      if (input.AgentPricing.pricingType === PricingType.Fixed) {
        const blockfrost = getBlockfrostInstance(
          input.network,
          sellingWallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
        );

        const assetUnits = input.AgentPricing.Pricing.map(
          (pricing) => pricing.unit,
        );
        const { valid: _validAssets, invalid: invalidAssets } =
          await validateAssetsOnChain(blockfrost, assetUnits);

        if (invalidAssets.length > 0) {
          const invalidAssetsMessage = invalidAssets
            .map((item) => `${item.asset} (${item.errorMessage})`)
            .join(', ');
          recordBusinessEndpointError(
            '/api/v1/registry',
            'POST',
            400,
            `Invalid assets in pricing: ${invalidAssetsMessage}`,
            {
              network: input.network,
              operation: 'register_agent',
              step: 'asset_validation',
              invalid_assets: invalidAssets
                .map((item) => `${item.asset}: ${item.errorMessage}`)
                .join('; '),
            },
          );
          throw createHttpError(
            400,
            `Invalid assets in pricing: ${invalidAssetsMessage}`,
          );
        }
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
              id: sellingWallet.paymentSourceId,
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
            include: {
              FixedPricing: {
                include: { Amounts: { select: { unit: true, amount: true } } },
              },
            },
          },
          SmartContractWallet: {
            select: { walletVkey: true, walletAddress: true },
          },
          ExampleOutputs: {
            select: {
              name: true,
              url: true,
              mimeType: true,
            },
          },
          CurrentTransaction: {
            select: {
              txHash: true,
              status: true,
              confirmations: true,
              fees: true,
              blockHeight: true,
              blockTime: true,
            },
          },
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
        AgentPricing:
          result.Pricing.pricingType == PricingType.Fixed
            ? {
                pricingType: PricingType.Fixed,
                Pricing:
                  result.Pricing.FixedPricing?.Amounts.map((price) => ({
                    unit: price.unit,
                    amount: price.amount.toString(),
                  })) ?? [],
              }
            : {
                pricingType: PricingType.Free,
              },
        Tags: result.tags,
        CurrentTransaction: result.CurrentTransaction
          ? {
              ...result.CurrentTransaction,
              fees: result.CurrentTransaction.fees?.toString() ?? null,
            }
          : null,
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
          user_id: ctx.id,
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

export const deleteAgentRegistrationSchemaOutput = registryRequestOutputSchema;

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
          PaymentSource: {
            select: {
              id: true,
              network: true,
              policyId: true,
              smartContractAddress: true,
            },
          },
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

      const item = await prisma.registryRequest.delete({
        where: {
          id: registryRequest.id,
        },
        include: {
          Pricing: {
            include: {
              FixedPricing: {
                include: { Amounts: { select: { unit: true, amount: true } } },
              },
            },
          },
          SmartContractWallet: {
            select: { walletVkey: true, walletAddress: true },
          },
          ExampleOutputs: {
            select: { name: true, url: true, mimeType: true },
          },
          CurrentTransaction: {
            select: {
              txHash: true,
              status: true,
              confirmations: true,
              fees: true,
              blockHeight: true,
              blockTime: true,
            },
          },
        },
      });

      return {
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
        CurrentTransaction: item.CurrentTransaction
          ? {
              ...item.CurrentTransaction,
              fees: item.CurrentTransaction.fees?.toString() ?? null,
            }
          : null,
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
