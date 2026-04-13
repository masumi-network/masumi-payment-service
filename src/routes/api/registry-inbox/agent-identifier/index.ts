import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import { z } from '@/utils/zod-openapi';
import { Network } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { logger } from '@/utils/logger';
import { extractPolicyId, extractAssetName } from '@/utils/converter/agent-identifier';
import { validateHexString } from '@/utils/validator/hex';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { parseInboxAgentRegistrationMetadata } from '@/services/registry-inbox/metadata';
import { buildManagedHolderWalletScopeFilter } from '@/utils/shared/wallet-scope';

export const queryInboxAgentByIdentifierSchemaInput = z.object({
	agentIdentifier: z.string().min(57).max(250).describe('Full inbox agent identifier (policy ID + asset name in hex)'),
	network: z.nativeEnum(Network).describe('The Cardano network (Preprod or Mainnet)'),
});

const inboxAgentMetadataObjectSchema = z.object({
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
});

export const queryInboxAgentByIdentifierSchemaOutput = z
	.object({
		policyId: z.string().describe('Policy ID of the inbox registry NFT'),
		assetName: z.string().describe('Asset name of the inbox registry NFT'),
		agentIdentifier: z.string().describe('Full inbox agent identifier (policy ID + asset name)'),
		Metadata: inboxAgentMetadataObjectSchema.describe('On-chain metadata for the inbox agent'),
	})
	.openapi('InboxAgentIdentifierMetadata');

export const queryInboxAgentByIdentifierGet = readAuthenticatedEndpointFactory.build({
	method: 'get',
	input: queryInboxAgentByIdentifierSchemaInput,
	output: queryInboxAgentByIdentifierSchemaOutput,
	handler: async ({
		input,
		ctx,
	}: {
		input: z.infer<typeof queryInboxAgentByIdentifierSchemaInput>;
		ctx: AuthContext;
	}) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

		if (validateHexString(input.agentIdentifier) == false) {
			throw createHttpError(400, 'Agent identifier is not a valid hex string');
		}

		const policyId = extractPolicyId(input.agentIdentifier);
		const paymentSource = await prisma.paymentSource.findFirst({
			where: {
				network: input.network,
				policyId,
				deletedAt: null,
			},
			include: {
				PaymentSourceConfig: { select: { rpcProviderApiKey: true } },
			},
		});
		if (paymentSource == null) {
			throw createHttpError(404, 'Network and policyId combination not supported');
		}

		if (ctx.walletScopeIds !== null) {
			const ownedInboxRegistration = await prisma.inboxAgentRegistrationRequest.findFirst({
				where: {
					agentIdentifier: input.agentIdentifier,
					PaymentSource: {
						network: input.network,
						deletedAt: null,
					},
					SmartContractWallet: {
						deletedAt: null,
					},
					...buildManagedHolderWalletScopeFilter(ctx.walletScopeIds),
				},
				select: {
					id: true,
				},
			});

			if (ownedInboxRegistration == null) {
				throw createHttpError(404, 'Agent not found');
			}
		}

		const blockfrost = getBlockfrostInstance(input.network, paymentSource.PaymentSourceConfig.rpcProviderApiKey);

		let assetInfo;
		try {
			assetInfo = await blockfrost.assetsById(input.agentIdentifier);
		} catch (error) {
			if (
				error instanceof Error &&
				(error.message.includes('404') ||
					error.message.toLocaleLowerCase().includes('not found') ||
					error.message.toLocaleLowerCase().includes('not been found'))
			) {
				throw createHttpError(404, 'Agent identifier not found');
			}
			logger.error('Error fetching inbox agent metadata from blockchain', {
				error: error instanceof Error ? error.message : String(error),
				agentIdentifier: input.agentIdentifier,
				network: input.network,
			});
			throw createHttpError(500, 'Error fetching asset metadata from blockchain');
		}

		if (!assetInfo || !assetInfo.onchain_metadata) {
			throw createHttpError(404, 'Inbox agent registry metadata not found');
		}

		const parsedMetadata = parseInboxAgentRegistrationMetadata(assetInfo.onchain_metadata);
		if (parsedMetadata == null) {
			logger.error('Error parsing inbox agent metadata', {
				error: assetInfo.onchain_metadata,
				agentIdentifier: input.agentIdentifier,
			});
			throw createHttpError(422, 'Inbox agent metadata is invalid or malformed');
		}

		return {
			policyId,
			assetName: extractAssetName(input.agentIdentifier),
			agentIdentifier: input.agentIdentifier,
			Metadata: {
				name: parsedMetadata.name,
				description: parsedMetadata.description,
				agentSlug: parsedMetadata.agentSlug,
				metadataVersion: parsedMetadata.metadataVersion,
			},
		};
	},
});
