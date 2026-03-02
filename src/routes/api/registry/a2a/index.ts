import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { z } from '@/utils/zod-openapi';
import { HotWalletType, Network, PaymentType, PricingType, RegistrationState } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { DEFAULTS } from '@/utils/config';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { fetchAndValidateAgentCard, AgentCard } from '@/utils/validator/agent-card';
import { registryRequestOutputSchema } from '@/routes/api/registry';
import { mapRegistryRequestToOutput } from '@/routes/api/registry/utils';
import { recordBusinessEndpointError } from '@/utils/metrics';

export const registerA2AAgentSchemaInput = z.object({
	network: z.nativeEnum(Network).describe('The Cardano network used to register the agent on'),
	sellingWalletVkey: z.string().max(250).describe('The payment key of a specific wallet used for the registration'),
	name: z.string().max(250).describe('Name of the agent'),
	apiBaseUrl: z.string().url().max(500).describe('Base URL of the agent API for interactions'),
	agentCardUrl: z
		.string()
		.url()
		.max(500)
		.refine((u) => u.startsWith('https://'), { message: 'Agent card URL must use HTTPS' })
		.describe('URL to the Agent Card JSON (typically /.well-known/agent-card.json)'),
	a2aProtocolVersions: z.array(z.string().max(20)).min(1).max(10).describe('A2A protocol versions this agent supports'),
	description: z.string().max(250).optional().describe('Description of the agent'),
	Tags: z.array(z.string().max(63)).max(15).optional().default([]).describe('Tags used in the registry metadata'),
	skipAgentCardValidation: z
		.boolean()
		.default(false)
		.describe('Skip fetching and validating the Agent Card URL. Use with caution.'),
});

export const registerA2AAgentSchemaOutput = registryRequestOutputSchema;

export const registerA2AAgentPost = payAuthenticatedEndpointFactory.build({
	method: 'post',
	input: registerA2AAgentSchemaInput,
	output: registerA2AAgentSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof registerA2AAgentSchemaInput>; ctx: AuthContext }) => {
		const startTime = Date.now();
		try {
			await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network, ctx.permission);

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
					'/api/v1/registry/a2a',
					'POST',
					404,
					'Network and Address combination not supported',
					{
						network: input.network,
						operation: 'register_a2a_agent',
						step: 'wallet_lookup',
						wallet_vkey: input.sellingWalletVkey,
					},
				);
				throw createHttpError(404, 'Network and Address combination not supported');
			}

			// Fetch and validate the Agent Card unless explicitly skipped
			let agentCard: AgentCard | null = null;
			if (!input.skipAgentCardValidation) {
				agentCard = await fetchAndValidateAgentCard(input.agentCardUrl, input.a2aProtocolVersions);
			}

			const result = await prisma.registryRequest.create({
				data: {
					name: input.name,
					description: input.description ?? null,
					apiBaseUrl: input.apiBaseUrl,

					// A2A on-chain fields:
					agentCardUrl: input.agentCardUrl,
					a2aProtocolVersions: input.a2aProtocolVersions,

					// A2A Agent Card data (populated when card was fetched; null/[] when skipped):
					a2aAgentVersion: agentCard?.version ?? null,
					a2aDefaultInputModes: agentCard?.defaultInputModes ?? [],
					a2aDefaultOutputModes: agentCard?.defaultOutputModes ?? [],
					a2aProviderName: agentCard?.provider?.organization ?? null,
					a2aProviderUrl: agentCard?.provider?.url ?? null,
					a2aDocumentationUrl: agentCard?.documentationUrl ?? null,
					a2aIconUrl: agentCard?.iconUrl ?? null,
					a2aCapabilitiesStreaming: agentCard?.capabilities?.streaming ?? null,
					a2aCapabilitiesPushNotifications: agentCard?.capabilities?.pushNotifications ?? null,

					// v1-specific fields — null/empty for A2A:
					capabilityName: null,
					capabilityVersion: null,
					other: null,
					terms: null,
					privacyPolicy: null,
					authorName: '',
					paymentType: PaymentType.Web3CardanoV1,
					authorContactEmail: null,
					authorContactOther: null,
					authorOrganization: null,
					state: RegistrationState.RegistrationRequested,
					agentIdentifier: null,
					metadataVersion: DEFAULTS.A2A_METADATA_VERSION,
					tags: input.Tags,

					SmartContractWallet: { connect: { id: sellingWallet.id } },
					PaymentSource: { connect: { id: sellingWallet.paymentSourceId } },

					// A2A pricing is off-chain (via x402 in Agent Card); register as Free here
					Pricing: { create: { pricingType: PricingType.Free } },
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

			return mapRegistryRequestToOutput(result);
		} catch (error: unknown) {
			const errorInstance = error instanceof Error ? error : new Error(String(error));
			const statusCode =
				(errorInstance as { statusCode?: number; status?: number }).statusCode ||
				(errorInstance as { statusCode?: number; status?: number }).status ||
				500;
			recordBusinessEndpointError('/api/v1/registry/a2a', 'POST', statusCode, errorInstance, {
				network: input.network,
				operation: 'register_a2a_agent',
				duration: Date.now() - startTime,
			});
			throw error;
		}
	},
});
