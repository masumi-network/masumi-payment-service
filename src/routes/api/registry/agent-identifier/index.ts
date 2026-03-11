import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import { z } from '@/utils/zod-openapi';
import { Network, PricingType } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { logger } from '@/utils/logger';
import { extractPolicyId, extractAssetName } from '@/utils/converter/agent-identifier';
import { validateHexString } from '@/utils/validator/hex';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { metadataSchemaCombined, metadataSchema, metadataSchemaV2 } from '@/routes/api/registry/wallet';
import { metadataToString } from '@/utils/converter/metadata-string-convert';

export const queryAgentByIdentifierSchemaInput = z.object({
	agentIdentifier: z.string().min(57).max(250).describe('Full agent identifier (policy ID + asset name in hex)'),
	network: z.nativeEnum(Network).describe('The Cardano network (Preprod or Mainnet)'),
});

const agentMetadataObjectSchema = z.object({
	name: z.string().max(250).describe('Name of the agent'),
	description: z.string().max(250).nullable().optional().describe('Description of the agent. Null if not provided'),
	apiBaseUrl: z.string().max(250).describe('Base URL of the agent API for interactions'),
	ExampleOutputs: z
		.array(
			z.object({
				name: z.string().max(60).describe('Name of the example output'),
				mimeType: z.string().max(60).describe('MIME type of the example output (e.g., image/png, text/plain)'),
				url: z.string().max(250).describe('URL to the example output'),
			}),
		)
		.max(25)
		.optional()
		.describe('List of example outputs from the agent. Empty for A2A agents'),
	Tags: z.array(z.string().max(250)).describe('List of tags categorizing the agent'),
	Capability: z
		.object({
			name: z.string().max(250).nullable().optional().describe('Name of the AI model/capability. Null if not provided'),
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
		.nullable()
		.optional()
		.describe('Author information for the agent. Null for A2A agents'),
	Legal: z
		.object({
			privacyPolicy: z
				.string()
				.max(250)
				.nullable()
				.optional()
				.describe('URL to the privacy policy. Null if not provided'),
			terms: z.string().max(250).nullable().optional().describe('URL to the terms of service. Null if not provided'),
			other: z.string().max(250).nullable().optional().describe('Other legal information. Null if not provided'),
		})
		.nullable()
		.optional()
		.describe('Legal information about the agent. Null if not provided'),
	AgentPricing: z
		.object({
			pricingType: z.enum([PricingType.Fixed]).describe('Pricing type for the agent (Fixed)'),
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
				pricingType: z.enum([PricingType.Free]).describe('Pricing type for the agent (Free)'),
			}),
		)
		.optional()
		.describe('Pricing information for the agent. Absent for A2A agents (pricing is off-chain)'),
	image: z.string().max(250).describe('URL to the agent image/logo'),
	metadataVersion: z.coerce
		.number()
		.int()
		.min(1)
		.max(2)
		.describe('Version of the metadata schema (1=standard MIP-002, 2=MIP-002-A2A)'),
	agentCardUrl: z.string().nullable().optional().describe('Agent Card URL for A2A agents. Null for standard agents'),
	a2aProtocolVersions: z.array(z.string()).optional().describe('A2A protocol versions. Empty for standard agents'),
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
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

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

		// Step 8: Parse and validate metadata structure (supports v1 and v2)
		const parsedMetadata = metadataSchemaCombined.safeParse(assetInfo.onchain_metadata);
		if (!parsedMetadata.success) {
			logger.error('Error parsing agent metadata', {
				error: parsedMetadata.error,
				agentIdentifier: input.agentIdentifier,
			});
			throw createHttpError(422, 'Agent metadata is invalid or malformed');
		}

		const isV2 = parsedMetadata.data.metadata_version === 2;

		// Step 9: Transform and return
		if (isV2) {
			const data = parsedMetadata.data as z.infer<typeof metadataSchemaV2>;
			return {
				policyId: policyId,
				assetName: extractAssetName(input.agentIdentifier),
				agentIdentifier: input.agentIdentifier,
				Metadata: {
					name: metadataToString(data.name)!,
					description: metadataToString(data.description),
					apiBaseUrl: metadataToString(data.api_url)!,
					agentCardUrl: metadataToString(data.agent_card_url) ?? null,
					a2aProtocolVersions: data.a2a_protocol_versions,
					ExampleOutputs: [],
					Capability: null,
					Author: null,
					Legal: null,
					Tags: (data.tags ?? []).map((tag) => metadataToString(tag)!),
					AgentPricing: undefined,
					image: metadataToString(data.image) ?? '',
					metadataVersion: 2,
				},
			};
		}

		const data = parsedMetadata.data as z.infer<typeof metadataSchema>;
		return {
			policyId: policyId,
			assetName: extractAssetName(input.agentIdentifier),
			agentIdentifier: input.agentIdentifier,
			Metadata: {
				name: metadataToString(data.name)!,
				description: metadataToString(data.description),
				apiBaseUrl: metadataToString(data.api_base_url)!,
				agentCardUrl: null,
				a2aProtocolVersions: [],
				ExampleOutputs:
					data.example_output?.map((exampleOutput) => ({
						name: metadataToString(exampleOutput.name)!,
						mimeType: metadataToString(exampleOutput.mime_type)!,
						url: metadataToString(exampleOutput.url)!,
					})) ?? [],
				Capability: data.capability
					? {
							name: metadataToString(data.capability.name)!,
							version: metadataToString(data.capability.version)!,
						}
					: undefined,
				Author: {
					name: metadataToString(data.author.name)!,
					contactEmail: metadataToString(data.author.contact_email),
					contactOther: metadataToString(data.author.contact_other),
					organization: metadataToString(data.author.organization),
				},
				Legal: data.legal
					? {
							privacyPolicy: metadataToString(data.legal.privacy_policy),
							terms: metadataToString(data.legal.terms),
							other: metadataToString(data.legal.other),
						}
					: undefined,
				Tags: data.tags.map((tag) => metadataToString(tag)!),
				AgentPricing:
					data.agentPricing.pricingType == PricingType.Fixed
						? {
								pricingType: data.agentPricing.pricingType,
								Pricing: data.agentPricing.fixedPricing.map((price) => ({
									amount: price.amount.toString(),
									unit: metadataToString(price.unit)!,
								})),
							}
						: {
								pricingType: data.agentPricing.pricingType,
							},
				image: metadataToString(data.image)!,
				metadataVersion: data.metadata_version,
			},
		};
	},
});
