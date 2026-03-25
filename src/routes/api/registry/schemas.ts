import { Network, PricingType, RegistrationState, TransactionStatus } from '@/generated/prisma/client';
import { z } from '@/utils/zod-openapi';

export enum FilterStatus {
	Registered = 'Registered',
	Deregistered = 'Deregistered',
	Pending = 'Pending',
	Failed = 'Failed',
}

export const queryRegistryRequestSchemaInput = z.object({
	limit: z.coerce.number().min(1).max(100).default(10).describe('The number of registry entries to return'),
	cursorId: z.string().optional().describe('The cursor id to paginate through the results'),
	network: z.nativeEnum(Network).describe('The Cardano network used to register the agent on'),
	filterSmartContractAddress: z
		.string()
		.optional()
		.nullable()
		.describe('The smart contract address of the payment source'),
	filterStatus: z.nativeEnum(FilterStatus).optional().describe('Filter by registration status category'),
	searchQuery: z
		.string()
		.optional()
		.describe('Search query to filter by name, description, tags, wallet address, state, or price'),
});

export const registryRequestOutputSchema = z
	.object({
		error: z.string().nullable().describe('Error message if registration failed. Null if no error'),
		id: z.string().describe('Unique identifier for the registry request'),
		name: z.string().describe('Name of the agent'),
		description: z.string().nullable().describe('Description of the agent. Null if not provided'),
		apiBaseUrl: z.string().describe('Base URL of the agent API for interactions'),
		Capability: z
			.object({
				name: z.string().nullable().describe('Name of the AI model/capability. Null if not provided'),
				version: z.string().nullable().describe('Version of the AI model/capability. Null if not provided'),
			})
			.describe('Information about the AI model and version used by the agent'),
		Author: z
			.object({
				name: z.string().describe('Name of the agent author'),
				contactEmail: z.string().nullable().describe('Contact email of the author. Null if not provided'),
				contactOther: z.string().nullable().describe('Other contact information for the author. Null if not provided'),
				organization: z.string().nullable().describe('Organization of the author. Null if not provided'),
			})
			.describe('Author information for the agent'),
		Legal: z
			.object({
				privacyPolicy: z.string().nullable().describe('URL to the privacy policy. Null if not provided'),
				terms: z.string().nullable().describe('URL to the terms of service. Null if not provided'),
				other: z.string().nullable().describe('Other legal information. Null if not provided'),
			})
			.describe('Legal information about the agent'),
		state: z.nativeEnum(RegistrationState).describe('Current state of the registration process'),
		Tags: z.array(z.string()).describe('List of tags categorizing the agent'),
		createdAt: z.date().describe('Timestamp when the registry request was created'),
		updatedAt: z.date().describe('Timestamp when the registry request was last updated'),
		lastCheckedAt: z.date().nullable().describe('Timestamp when the registry was last checked. Null if never checked'),
		ExampleOutputs: z
			.array(
				z.object({
					name: z.string().max(60).describe('Name of the example output'),
					url: z.string().max(250).describe('URL to the example output'),
					mimeType: z.string().max(60).describe('MIME type of the example output (e.g., image/png, text/plain)'),
				}),
			)
			.max(25)
			.describe('List of example outputs from the agent'),
		agentIdentifier: z
			.string()
			.min(57)
			.max(250)
			.nullable()
			.describe('Full agent identifier (policy ID + asset name). Null if not yet minted'),
		AgentPricing: z
			.object({
				pricingType: z.enum([PricingType.Fixed]).describe('Pricing type for the agent'),
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
					pricingType: z.enum([PricingType.Free]).describe('Pricing type for the agent'),
				}),
			)
			.or(
				z.object({
					pricingType: z
						.enum([PricingType.Dynamic])
						.describe('Pricing type for the agent. Amounts are provided per payment/purchase request'),
				}),
			)
			.describe('Pricing information for the agent'),
		SmartContractWallet: z
			.object({
				walletVkey: z.string().describe('Payment key hash of the smart contract wallet'),
				walletAddress: z.string().describe('Cardano address of the smart contract wallet'),
			})
			.describe('Smart contract wallet managing this agent registration'),
		CurrentTransaction: z
			.object({
				txHash: z.string().nullable().describe('Cardano transaction hash'),
				status: z.nativeEnum(TransactionStatus).describe('Current status of the transaction'),
				confirmations: z
					.number()
					.nullable()
					.describe('Number of block confirmations for this transaction. Null if not yet confirmed'),
				fees: z.string().nullable().describe('Fees of the transaction'),
				blockHeight: z.number().nullable().describe('Block height of the transaction'),
				blockTime: z.number().nullable().describe('Block time of the transaction'),
			})
			.nullable(),
	})
	.openapi('RegistryEntry');

export const queryRegistryRequestSchemaOutput = z.object({
	Assets: z.array(registryRequestOutputSchema),
});

export const queryRegistryCountSchemaInput = z.object({
	network: z.nativeEnum(Network).describe('The Cardano network used to register the agent on'),
	filterSmartContractAddress: z
		.string()
		.optional()
		.nullable()
		.describe('The smart contract address of the payment source'),
});

export const queryRegistryCountSchemaOutput = z.object({
	total: z.number().describe('Total number of AI agents'),
});

export const registerAgentSchemaInput = z.object({
	network: z.nativeEnum(Network).describe('The Cardano network used to register the agent on'),
	sellingWalletVkey: z.string().max(250).describe('The payment key of a specific wallet used for the registration'),
	ExampleOutputs: z
		.array(
			z.object({
				name: z.string().max(60).describe('Name of the example output'),
				url: z.string().max(250).describe('URL to the example output'),
				mimeType: z.string().max(60).describe('MIME type of the example output (e.g., image/png, text/plain)'),
			}),
		)
		.max(25)
		.describe('List of example outputs from the agent'),
	Tags: z.array(z.string().max(63)).min(1).max(15).describe('Tags used in the registry metadata'),
	name: z.string().max(250).describe('Name of the agent'),
	apiBaseUrl: z.string().max(250).describe('Base URL of the agent, to request interactions'),
	description: z.string().max(250).describe('Description of the agent'),
	Capability: z
		.object({
			name: z.string().max(250).describe('Name of the AI model/capability'),
			version: z.string().max(250).describe('Version of the AI model/capability'),
		})
		.describe('Provide information about the used AI model and version'),
	AgentPricing: z
		.object({
			pricingType: z.enum([PricingType.Fixed]).describe('Pricing type for the agent'),
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
				pricingType: z.enum([PricingType.Free]).describe('Pricing type for the agent'),
			}),
		)
		.or(
			z.object({
				pricingType: z
					.enum([PricingType.Dynamic])
					.describe('Pricing type for the agent. Amounts are provided per payment/purchase request'),
			}),
		)
		.describe('Pricing information for the agent'),
	Legal: z
		.object({
			privacyPolicy: z.string().max(250).optional().describe('URL to the privacy policy'),
			terms: z.string().max(250).optional().describe('URL to the terms of service'),
			other: z.string().max(250).optional().describe('Other legal information'),
		})
		.optional()
		.describe('Legal information about the agent'),
	Author: z
		.object({
			name: z.string().max(250).describe('Name of the agent author'),
			contactEmail: z.string().max(250).optional().describe('Contact email of the author'),
			contactOther: z.string().max(250).optional().describe('Other contact information for the author'),
			organization: z.string().max(250).optional().describe('Organization of the author'),
		})
		.describe('Author information about the agent'),
});

export const registerAgentSchemaOutput = registryRequestOutputSchema;

export const deleteAgentRegistrationSchemaInput = z.object({
	id: z.string().cuid().describe('The database ID of the agent registration record to be deleted.'),
});

export const deleteAgentRegistrationSchemaOutput = registryRequestOutputSchema;
