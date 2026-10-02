import { readAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { Network, PricingType } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import { getRegistryScriptFromNetworkHandler } from '@/utils/generator/contract-generator';
import { DEFAULTS } from '@masumi/payment-core/config';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@masumi/payment-core/auth';
import { logger } from '@masumi/payment-core/logger';
import { extractAssetName } from '@/utils/converter/agent-identifier';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { assertHotWalletInScope } from '@/utils/shared/wallet-scope';
import { supportedPaymentSourcesSchema } from '@/types/payment-source';
import { verificationsSchema } from '@/types/verification';
import {
	mapParsedRegistryMetadataToApi,
	metadataSchema,
	resolveAgentPricingFromMetadata,
} from '@/routes/api/registry/metadata-schema';

export { metadataSchema, resolveAgentPricingFromMetadata, mapParsedRegistryMetadataToApi };

export const queryAgentFromWalletSchemaInput = z.object({
	walletVkey: z.string().max(250).describe('The payment key of the wallet to be queried'),
	network: z.nativeEnum(Network).describe('The Cardano network used to register the agent on'),
	smartContractAddress: z
		.string()
		.max(250)
		.optional()
		.describe('The smart contract address of the payment source to which the registration belongs'),
});

export const queryAgentFromWalletSchemaOutput = z.object({
	Assets: z
		.array(
			z
				.object({
					policyId: z.string().describe('Policy ID of the agent registry NFT'),
					assetName: z.string().describe('Asset name of the agent registry NFT'),
					agentIdentifier: z.string().describe('Full agent identifier (policy ID + asset name)'),
					Metadata: z
						.object({
							name: z.string().max(250).describe('Name of the agent'),
							description: z
								.string()
								.max(250)
								.nullable()
								.optional()
								.describe('Description of the agent. Null if not provided'),
							apiBaseUrl: z
								.string()
								.max(250)
								.describe(
									'Primary interaction URL: MIP api base, x402 manifest URL, or OpenAPI spec URL',
								),
							type: z
								.enum(['Standard', 'OpenApi', 'X402'])
								.optional()
								.describe('Registry entry type when encoded on-chain'),
							openApiSpecUrl: z
								.string()
								.max(250)
								.optional()
								.describe('OpenAPI spec URL for OpenApi registry entries'),
							x402ResourcesUrl: z
								.string()
								.max(250)
								.optional()
								.describe('x402 manifest URL for X402 registry entries'),
							ExampleOutputs: z
								.array(
									z.object({
										name: z.string().max(60).describe('Name of the example output'),
										mimeType: z
											.string()
											.max(60)
											.describe('MIME type of the example output (e.g., image/png, text/plain)'),
										url: z.string().max(250).describe('URL to the example output'),
									}),
								)
								.max(25)
								.describe('List of example outputs from the agent'),
							Tags: z.array(z.string().max(250)).describe('List of tags categorizing the agent'),
							Capability: z
								.object({
									name: z
										.string()
										.max(250)
										.nullable()
										.optional()
										.describe('Name of the AI model/capability. Null if not provided'),
									version: z
										.string()
										.max(250)
										.nullable()
										.optional()
										.describe('Version of the AI model/capability. Null if not provided'),
								})
								.nullable()
								.optional()
								.describe('Information about the AI model and version used by the agent. Null if not provided'),
							Author: z
								.object({
									name: z.string().max(250).describe('Name of the agent author'),
									contactEmail: z
										.string()
										.max(250)
										.nullable()
										.optional()
										.describe('Contact email of the author. Null if not provided'),
									contactOther: z
										.string()
										.max(250)
										.nullable()
										.optional()
										.describe('Other contact information for the author. Null if not provided'),
									organization: z
										.string()
										.max(250)
										.nullable()
										.optional()
										.describe('Organization of the author. Null if not provided'),
								})
								.describe('Author information for the agent'),
							Legal: z
								.object({
									privacyPolicy: z
										.string()
										.max(250)
										.nullable()
										.optional()
										.describe('URL to the privacy policy. Null if not provided'),
									terms: z
										.string()
										.max(250)
										.nullable()
										.optional()
										.describe('URL to the terms of service. Null if not provided'),
									other: z
										.string()
										.max(250)
										.nullable()
										.optional()
										.describe('Other legal information. Null if not provided'),
								})
								.nullable()
								.optional()
								.describe('Legal information about the agent. Null if not provided'),
							AgentPricing: z
								.object({
									pricingType: z.enum([PricingType.Fixed]).describe('Pricing type for the agent (Fixed or Free)'),
									Pricing: z
										.array(
											z.object({
												amount: z
													.string()
													.describe(
														'The quantity of the asset. Make sure to convert it from the underlying smallest unit (in case of decimals, multiply it by the decimal factor e.g. for 1 ADA = 1000000 lovelace)',
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
										pricingType: z.enum([PricingType.Free]).describe('Pricing type for the agent (Free)'),
									}),
								)
								.or(
									z.object({
										pricingType: z.enum([PricingType.Dynamic]).describe('Pricing type for the agent (Dynamic)'),
									}),
								)
								.nullable()
								.describe('V1 legacy pricing. Null for V2 metadata, which prices each source independently.'),
							image: z.string().max(250).describe('URL to the agent image/logo'),
							metadataVersion: z.coerce.number().int().min(1).max(2).describe('Version of the metadata schema'),
							supportedPaymentSources: supportedPaymentSourcesSchema
								.nullable()
								.describe('Payment sources advertised by this registry entry. Null for legacy metadata.'),
							verifications: verificationsSchema
								.nullable()
								.describe('KERI/Veridian verification claims advertised by this registry entry. Null when none.'),
						})
						.describe('On-chain metadata for the agent'),
				})
				.openapi('AgentMetadata'),
		)
		.describe('List of agent assets registered to this wallet'),
});

export const queryAgentFromWalletGet = readAuthenticatedEndpointFactory.build({
	method: 'get',
	input: queryAgentFromWalletSchemaInput,
	output: queryAgentFromWalletSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof queryAgentFromWalletSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);
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
				PaymentSourceConfig: { select: { rpcProviderApiKey: true } },
				HotWallets: {
					where: { deletedAt: null },
					select: {
						id: true,
						walletVkey: true,
						walletAddress: true,
						type: true,
					},
				},
			},
		});
		if (paymentSource == null) {
			throw createHttpError(404, 'Network and Address combination not supported');
		}

		const blockfrost = getBlockfrostInstance(input.network, paymentSource.PaymentSourceConfig.rpcProviderApiKey);
		const wallet = paymentSource.HotWallets.find((wallet) => wallet.walletVkey == input.walletVkey);
		if (wallet == null) {
			throw createHttpError(404, 'Wallet not found');
		}
		assertHotWalletInScope(ctx.walletScopeIds, wallet.id);
		const { policyId } = await getRegistryScriptFromNetworkHandler(paymentSource);

		const addressInfo = await blockfrost.addresses(wallet.walletAddress);
		if (addressInfo.stake_address == null) {
			throw createHttpError(404, 'Stake address not found');
		}
		const stakeAddress = addressInfo.stake_address;

		const holderWallet = await blockfrost.accountsAddressesAssetsAll(stakeAddress);
		if (!holderWallet || holderWallet.length == 0) {
			throw createHttpError(404, 'Asset not found');
		}
		const assets = holderWallet.filter((asset) => asset.unit.startsWith(policyId));
		const detailedAssets: Array<{
			unit: string;
			Metadata: z.infer<typeof queryAgentFromWalletSchemaOutput>['Assets'][0]['Metadata'];
		}> = [];

		await Promise.all(
			assets.map(async (asset) => {
				const assetInfo = await blockfrost.assetsById(asset.unit);
				const parsedMetadata = metadataSchema.safeParse(assetInfo.onchain_metadata);
				if (!parsedMetadata.success) {
					const error = parsedMetadata.error;
					logger.error('Error parsing metadata', { error });
					return;
				}
				const resolvedAgentPricing = resolveAgentPricingFromMetadata(parsedMetadata.data);
				if (parsedMetadata.data.metadata_version === 1 && resolvedAgentPricing == null) {
					logger.error('Agent metadata does not advertise any pricing', { unit: asset.unit });
					return;
				}
				const metadataApi = mapParsedRegistryMetadataToApi(parsedMetadata.data, {
					filterPaymentSourcesForNetwork: input.network,
				});
				if (metadataApi == null) {
					logger.error('Agent metadata is missing an interaction URL', { unit: asset.unit });
					return;
				}
				detailedAssets.push({
					unit: asset.unit,
					Metadata: metadataApi,
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
