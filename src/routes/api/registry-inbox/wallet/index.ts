import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import { z } from '@/utils/zod-openapi';
import { Network } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { getRegistryScriptFromNetworkHandlerV1 } from '@/utils/generator/contract-generator';
import { metadataToString } from '@/utils/converter/metadata-string-convert';
import { DEFAULTS } from '@/utils/config';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { logger } from '@/utils/logger';
import { extractAssetName } from '@/utils/converter/agent-identifier';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { assertHotWalletInScope } from '@/utils/shared/wallet-scope';

export const inboxMetadataSchema = z.object({
	name: z
		.string()
		.min(1)
		.or(z.array(z.string().min(1))),
	description: z.string().or(z.array(z.string())).optional(),
	agentslug: z
		.string()
		.min(1)
		.or(z.array(z.string().min(1))),
	metadata_version: z.coerce.number().int().min(1).max(1),
});

export const queryInboxAgentFromWalletSchemaInput = z.object({
	walletVkey: z.string().max(250).describe('The payment key of the wallet to be queried'),
	network: z.nativeEnum(Network).describe('The Cardano network used to register the inbox agent on'),
	smartContractAddress: z
		.string()
		.max(250)
		.optional()
		.describe('The smart contract address of the payment source to which the registration belongs'),
});

export const queryInboxAgentFromWalletSchemaOutput = z.object({
	Assets: z
		.array(
			z
				.object({
					policyId: z.string().describe('Policy ID of the inbox registry NFT'),
					assetName: z.string().describe('Asset name of the inbox registry NFT'),
					agentIdentifier: z.string().describe('Full inbox agent identifier (policy ID + asset name)'),
					Metadata: z
						.object({
							name: z.string().max(120).describe('Name of the inbox agent'),
							description: z
								.string()
								.max(500)
								.nullable()
								.optional()
								.describe('Description of the inbox agent. Null if not provided'),
							agentSlug: z.string().max(80).describe('Canonical inbox agent slug'),
							metadataVersion: z.coerce
								.number()
								.int()
								.min(1)
								.max(1)
								.describe('Version of the metadata schema (currently only version 1 is supported)'),
						})
						.describe('On-chain metadata for the inbox agent'),
				})
				.openapi('InboxAgentMetadata'),
		)
		.describe('List of inbox agent assets registered to this wallet'),
});

export const queryInboxAgentFromWalletGet = readAuthenticatedEndpointFactory.build({
	method: 'get',
	input: queryInboxAgentFromWalletSchemaInput,
	output: queryInboxAgentFromWalletSchemaOutput,
	handler: async ({
		input,
		ctx,
	}: {
		input: z.infer<typeof queryInboxAgentFromWalletSchemaInput>;
		ctx: AuthContext;
	}) => {
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
					smartContractAddress,
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
		const { policyId } = await getRegistryScriptFromNetworkHandlerV1(paymentSource);

		const addressInfo = await blockfrost.addresses(wallet.walletAddress);
		if (addressInfo.stake_address == null) {
			throw createHttpError(404, 'Stake address not found');
		}
		const holderWallet = await blockfrost.accountsAddressesAssetsAll(addressInfo.stake_address);
		if (!holderWallet || holderWallet.length == 0) {
			throw createHttpError(404, 'Asset not found');
		}
		const assets = holderWallet.filter((asset) => asset.unit.startsWith(policyId));
		const detailedAssets: Array<{
			unit: string;
			Metadata: z.infer<typeof queryInboxAgentFromWalletSchemaOutput>['Assets'][0]['Metadata'];
		}> = [];

		await Promise.all(
			assets.map(async (asset) => {
				const assetInfo = await blockfrost.assetsById(asset.unit);
				const parsedMetadata = inboxMetadataSchema.safeParse(assetInfo.onchain_metadata);
				if (!parsedMetadata.success) {
					logger.debug('Skipping non-inbox registry metadata while querying inbox wallet assets', {
						asset: asset.unit,
					});
					return;
				}
				detailedAssets.push({
					unit: asset.unit,
					Metadata: {
						name: metadataToString(parsedMetadata.data.name)!,
						description: metadataToString(parsedMetadata.data.description),
						agentSlug: metadataToString(parsedMetadata.data.agentslug)!,
						metadataVersion: parsedMetadata.data.metadata_version,
					},
				});
			}),
		);

		return {
			Assets: detailedAssets.map((asset) => ({
				policyId,
				assetName: extractAssetName(asset.unit),
				agentIdentifier: asset.unit,
				Metadata: asset.Metadata,
			})),
		};
	},
});
