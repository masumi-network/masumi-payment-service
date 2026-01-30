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
import { metadataSchema } from '@/routes/api/registry/wallet';
import { agentMetadataObjectSchema } from '@/utils/shared/schemas';
import { transformParsedMetadataToResponse } from '@/utils/shared/transformers';

export const queryAgentByIdentifierSchemaInput = z.object({
	agentIdentifier: z.string().min(57).max(250).describe('Full agent identifier (policy ID + asset name in hex)'),
	network: z.nativeEnum(Network).describe('The Cardano network (Preprod or Mainnet)'),
});

export const queryAgentByIdentifierSchemaOutput = z
	.object({
		policyId: z.string().describe('Policy ID of the agent registry NFT'),
		assetName: z.string().describe('Asset name of the agent registry NFT'),
		agentIdentifier: z.string().describe('Full agent identifier (policy ID + asset name)'),
		Metadata: agentMetadataObjectSchema.describe('On-chain metadata for the agent'),
	})
	.openapi('AgentIdentifierMetadata');

export const queryAgentByIdentifierGet = readAuthenticatedEndpointFactory.build({
	method: 'get',
	input: queryAgentByIdentifierSchemaInput,
	output: queryAgentByIdentifierSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof queryAgentByIdentifierSchemaInput>; ctx: AuthContext }) => {
		// Step 1: Network authorization check
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network, ctx.permission);

		// Step 2: Validate hex format BEFORE extracting policyId
		if (validateHexString(input.agentIdentifier) == false) {
			throw createHttpError(400, 'Agent identifier is not a valid hex string');
		}

		// Step 3: Extract policyId (min length already validated by Zod schema)
		const policyId = extractPolicyId(input.agentIdentifier);

		// Step 4: Find PaymentSource by policyId + network
		const paymentSource = await prisma.paymentSource.findFirst({
			where: {
				network: input.network,
				policyId: policyId,
				deletedAt: null,
			},
			include: {
				PaymentSourceConfig: { select: { rpcProviderApiKey: true } },
			},
		});
		if (paymentSource == null) {
			throw createHttpError(404, 'Network and policyId combination not supported');
		}

		// Step 5: Get Blockfrost instance
		const blockfrost = getBlockfrostInstance(input.network, paymentSource.PaymentSourceConfig.rpcProviderApiKey);

		// Step 6: Query asset metadata from blockchain with try-catch
		let assetInfo;
		try {
			assetInfo = await blockfrost.assetsById(input.agentIdentifier);
		} catch (error) {
			// Use comprehensive 404 detection pattern from src/utils/blockfrost/index.ts
			if (
				error instanceof Error &&
				(error.message.includes('404') ||
					error.message.toLocaleLowerCase().includes('not found') ||
					error.message.toLocaleLowerCase().includes('not been found'))
			) {
				throw createHttpError(404, 'Agent identifier not found');
			}
			// Log the actual error for debugging before throwing generic 500
			logger.error('Error fetching asset metadata from blockchain', {
				error: error instanceof Error ? error.message : String(error),
				agentIdentifier: input.agentIdentifier,
				network: input.network,
			});
			throw createHttpError(500, 'Error fetching asset metadata from blockchain');
		}

		// Step 7: Check metadata exists
		if (!assetInfo || !assetInfo.onchain_metadata) {
			throw createHttpError(404, 'Agent registry metadata not found');
		}

		// Step 8: Parse and validate metadata structure
		const parsedMetadata = metadataSchema.safeParse(assetInfo.onchain_metadata);
		if (!parsedMetadata.success) {
			logger.error('Error parsing agent metadata', {
				error: parsedMetadata.error,
				agentIdentifier: input.agentIdentifier,
			});
			throw createHttpError(422, 'Agent metadata is invalid or malformed');
		}

		// Step 9: Transform and return
		return {
			policyId: policyId,
			assetName: extractAssetName(input.agentIdentifier),
			agentIdentifier: input.agentIdentifier,
			Metadata: transformParsedMetadataToResponse(parsedMetadata.data),
		};
	},
});
