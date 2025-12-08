import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { z } from 'zod';
import { $Enums, HotWalletType, Network, PricingType } from '@prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { getRegistryScriptFromNetworkHandlerV1 } from '@/utils/generator/contract-generator';
import { metadataToString } from '@/utils/converter/metadata-string-convert';
import { DEFAULTS } from '@/utils/config';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { logger } from '@/utils/logger';
import { extractAssetName } from '@/utils/converter/agent-identifier';

export const metadataSchema = z.object({
  name: z
    .string()
    .min(1)
    .or(z.array(z.string().min(1))),
  description: z.string().or(z.array(z.string())).optional(),
  api_base_url: z
    .string()
    .min(1)
    .or(z.array(z.string().min(1))),
  example_output: z
    .array(
      z.object({
        name: z
          .string()
          .max(60)
          .or(z.array(z.string().max(60)).min(1).max(1)),
        mime_type: z
          .string()
          .min(1)
          .max(60)
          .or(z.array(z.string().min(1).max(60)).min(1).max(1)),
        url: z.string().or(z.array(z.string())),
      }),
    )
    .optional(),
  capability: z
    .object({
      name: z.string().or(z.array(z.string())),
      version: z
        .string()
        .max(60)
        .or(z.array(z.string().max(60)).min(1).max(1)),
    })
    .optional(),
  author: z.object({
    name: z
      .string()
      .min(1)
      .or(z.array(z.string().min(1))),
    contact_email: z.string().or(z.array(z.string())).optional(),
    contact_other: z.string().or(z.array(z.string())).optional(),
    organization: z.string().or(z.array(z.string())).optional(),
  }),
  legal: z
    .object({
      privacy_policy: z.string().or(z.array(z.string())).optional(),
      terms: z.string().or(z.array(z.string())).optional(),
      other: z.string().or(z.array(z.string())).optional(),
    })
    .optional(),
  tags: z.array(z.string().min(1)).min(1),
  agentPricing: z
    .object({
      pricingType: z.enum([PricingType.Fixed]),
      fixedPricing: z
        .array(
          z.object({
            amount: z.number({ coerce: true }).int().min(1),
            unit: z
              .string()
              .min(1)
              .or(z.array(z.string().min(1))),
          }),
        )
        .min(1)
        .max(25),
    })
    .or(
      z.object({
        pricingType: z.enum([PricingType.Free]),
      }),
    ),
  image: z.string().or(z.array(z.string())),
  metadata_version: z.number({ coerce: true }).int().min(1).max(1),
});

export const queryAgentFromWalletSchemaInput = z.object({
  walletVKey: z
    .string()
    .max(250)
    .describe('The payment key of the wallet to be queried'),
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

export const queryAgentFromWalletSchemaOutput = z.object({
  Assets: z.array(
    z.object({
      policyId: z.string(),
      assetName: z.string(),
      agentIdentifier: z.string(),
      Metadata: z.object({
        name: z.string().max(250),
        description: z.string().max(250).nullable().optional(),
        apiBaseUrl: z.string().max(250),
        ExampleOutputs: z
          .array(
            z.object({
              name: z.string().max(60),
              mimeType: z.string().max(60),
              url: z.string().max(250),
            }),
          )
          .max(25),
        Tags: z.array(z.string().max(250)),
        Capability: z
          .object({
            name: z.string().max(250).nullable().optional(),
            version: z.string().max(250).nullable().optional(),
          })
          .nullable()
          .optional(),
        Author: z.object({
          name: z.string().max(250),
          contactEmail: z.string().max(250).nullable().optional(),
          contactOther: z.string().max(250).nullable().optional(),
          organization: z.string().max(250).nullable().optional(),
        }),
        Legal: z
          .object({
            privacyPolicy: z.string().max(250).nullable().optional(),
            terms: z.string().max(250).nullable().optional(),
            other: z.string().max(250).nullable().optional(),
          })
          .nullable()
          .optional(),
        AgentPricing: z
          .object({
            pricingType: z.enum([PricingType.Fixed]),
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
              .min(1),
          })
          .or(
            z.object({
              pricingType: z.enum([PricingType.Free]),
            }),
          ),
        image: z.string().max(250),
        metadataVersion: z.number({ coerce: true }).int().min(1).max(1),
      }),
    }),
  ),
});

export const queryAgentFromWalletGet = payAuthenticatedEndpointFactory.build({
  method: 'get',
  input: queryAgentFromWalletSchemaInput,
  output: queryAgentFromWalletSchemaOutput,
  handler: async ({
    input,
    options,
  }: {
    input: z.infer<typeof queryAgentFromWalletSchemaInput>;
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
        HotWallets: { where: { deletedAt: null } },
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
    const wallet = paymentSource.HotWallets.find(
      (wallet) =>
        wallet.walletVkey == input.walletVKey &&
        wallet.type == HotWalletType.Selling,
    );
    if (wallet == null) {
      throw createHttpError(404, 'Wallet not found');
    }
    const { policyId } =
      await getRegistryScriptFromNetworkHandlerV1(paymentSource);

    const addressInfo = await blockfrost.addresses(wallet.walletAddress);
    if (addressInfo.stake_address == null) {
      throw createHttpError(404, 'Stake address not found');
    }
    const stakeAddress = addressInfo.stake_address;

    const holderWallet =
      await blockfrost.accountsAddressesAssetsAll(stakeAddress);
    if (!holderWallet || holderWallet.length == 0) {
      throw createHttpError(404, 'Asset not found');
    }
    const assets = holderWallet.filter((asset) =>
      asset.unit.startsWith(policyId),
    );
    const detailedAssets: Array<{
      unit: string;
      Metadata: z.infer<
        typeof queryAgentFromWalletSchemaOutput
      >['Assets'][0]['Metadata'];
    }> = [];

    await Promise.all(
      assets.map(async (asset) => {
        const assetInfo = await blockfrost.assetsById(asset.unit);
        const parsedMetadata = metadataSchema.safeParse(
          assetInfo.onchain_metadata,
        );
        if (!parsedMetadata.success) {
          const error = parsedMetadata.error;
          logger.error('Error parsing metadata', { error });
          return;
        }
        detailedAssets.push({
          unit: asset.unit,
          Metadata: {
            name: metadataToString(parsedMetadata.data.name)!,
            description: metadataToString(parsedMetadata.data.description),
            apiBaseUrl: metadataToString(parsedMetadata.data.api_base_url)!,
            ExampleOutputs:
              parsedMetadata.data.example_output?.map((exampleOutput) => ({
                name: metadataToString(exampleOutput.name)!,
                mimeType: metadataToString(exampleOutput.mime_type)!,
                url: metadataToString(exampleOutput.url)!,
              })) ?? [],
            Capability: parsedMetadata.data.capability
              ? {
                  name: metadataToString(parsedMetadata.data.capability.name)!,
                  version: metadataToString(
                    parsedMetadata.data.capability.version,
                  )!,
                }
              : undefined,
            Author: {
              name: metadataToString(parsedMetadata.data.author.name)!,
              contactEmail: metadataToString(
                parsedMetadata.data.author.contact_email,
              ),
              contactOther: metadataToString(
                parsedMetadata.data.author.contact_other,
              ),
              organization: metadataToString(
                parsedMetadata.data.author.organization,
              ),
            },
            Legal: parsedMetadata.data.legal
              ? {
                  privacyPolicy: metadataToString(
                    parsedMetadata.data.legal.privacy_policy,
                  ),
                  terms: metadataToString(parsedMetadata.data.legal.terms),
                  other: metadataToString(parsedMetadata.data.legal.other),
                }
              : undefined,
            Tags: parsedMetadata.data.tags.map((tag) => metadataToString(tag)!),
            AgentPricing:
              parsedMetadata.data.agentPricing.pricingType == PricingType.Fixed
                ? {
                    pricingType: parsedMetadata.data.agentPricing.pricingType,
                    Pricing: parsedMetadata.data.agentPricing.fixedPricing.map(
                      (price) => ({
                        amount: price.amount.toString(),
                        unit: metadataToString(price.unit)!,
                      }),
                    ),
                  }
                : {
                    pricingType: parsedMetadata.data.agentPricing.pricingType,
                  },
            image: metadataToString(parsedMetadata.data.image)!,
            metadataVersion: parsedMetadata.data.metadata_version,
          },
        });
      }),
    );

    return {
      Assets: detailedAssets.map((asset) => ({
        policyId: policyId,
        assetName: extractAssetName(asset.unit),
        agentIdentifier: asset.unit,
        Metadata: asset.Metadata,
        Tags: asset.Metadata.Tags,
      })),
    };
  },
});
