import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { z } from '@/utils/zod-openapi';
import { HotWalletType, Network, PricingType } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { getRegistryScriptFromNetworkHandlerV1 } from '@/utils/generator/contract-generator';
import { DEFAULTS } from '@/utils/config';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { logger } from '@/utils/logger';
import { extractAssetName } from '@/utils/converter/agent-identifier';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { agentMetadataObjectSchema } from '@/utils/shared/schemas';
import { transformParsedMetadataToResponse } from '@/utils/shared/transformers';

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
						amount: z.coerce.number().int().min(1),
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
	metadata_version: z.coerce.number().int().min(1).max(1),
});

export const queryAgentFromWalletSchemaInput = z.object({
	walletVKey: z.string().max(250).describe('The payment key of the wallet to be queried'),
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
					Metadata: agentMetadataObjectSchema.describe('On-chain metadata for the agent'),
				})
				.openapi('AgentMetadata'),
		)
		.describe('List of agent assets registered to this wallet'),
});

export const queryAgentFromWalletGet = payAuthenticatedEndpointFactory.build({
	method: 'get',
	input: queryAgentFromWalletSchemaInput,
	output: queryAgentFromWalletSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof queryAgentFromWalletSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network, ctx.permission);
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
		const wallet = paymentSource.HotWallets.find(
			(wallet) => wallet.walletVkey == input.walletVKey && wallet.type == HotWalletType.Selling,
		);
		if (wallet == null) {
			throw createHttpError(404, 'Wallet not found');
		}
		const { policyId } = await getRegistryScriptFromNetworkHandlerV1(paymentSource);

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
				detailedAssets.push({
					unit: asset.unit,
					Metadata: transformParsedMetadataToResponse(parsedMetadata.data),
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
