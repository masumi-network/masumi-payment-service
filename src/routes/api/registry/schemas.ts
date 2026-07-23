import {
	Network,
	PaymentSourceType,
	PricingType,
	RegistrationState,
	RegistryEntryType,
	TransactionStatus,
} from '@/generated/prisma/client';
import { atomicAmountSchema, supportedPaymentSourcesSchema } from '@/types/payment-source';
import { verificationsSchema } from '@/types/verification';
import { z } from '@masumi/payment-core/zod';

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
		.describe(
			'The smart contract address of the payment source. When omitted with no V2-aware filters, registry list/count endpoints default to Web3CardanoV1 for backwards compatibility. Supplying this field queries that exact V1 or V2 source.',
		),
	filterPaymentSourceType: z
		.nativeEnum(PaymentSourceType)
		.optional()
		.describe(
			'Filter by payment source type. When omitted with no source/address/identifier support filters, the endpoint defaults to Web3CardanoV1 for backwards compatibility.',
		),
	filterStatus: z.nativeEnum(FilterStatus).optional().describe('Filter by registration status category'),
	searchQuery: z
		.string()
		.optional()
		.describe(
			'Search query to filter by name, description, tags, minting or recipient wallet address, state, or price',
		),
	filterAgentIdentifier: z
		.string()
		.min(57)
		.max(250)
		.optional()
		.describe(
			'When set, return only the registry entry whose on-chain agent identifier matches exactly (same scope as list: network, payment source, and wallet permissions). This exact lookup does not apply the default Web3CardanoV1 compatibility filter.',
		),
	filterSupportedPaymentSourceAddress: z
		.string()
		.optional()
		.describe(
			'Return only entries that advertise a supported payment source with this address (the Cardano smart-contract address, or an EVM x402 payTo/address). Matched server-side so callers do not have to fetch every entry and filter client-side. Combined with filterSupportedPaymentSourceNetworks as a logical OR. This V2-aware filter opts out of the default Web3CardanoV1 compatibility filter.',
		),
	filterSupportedPaymentSourceNetworks: z
		.string()
		.optional()
		.describe(
			'Comma-separated list of supported-payment-source networks to match (Cardano network name, or CAIP-2 EVM chain ids such as eip155:8453). Returns entries advertising a supported payment source on any of these networks. Combined with filterSupportedPaymentSourceAddress as a logical OR. This V2-aware filter opts out of the default Web3CardanoV1 compatibility filter.',
		),
});

export const registryRequestOutputSchema = z
	.object({
		error: z.string().nullable().describe('Error message if registration failed. Null if no error'),
		id: z.string().describe('Unique identifier for the registry request'),
		name: z.string().describe('Name of the agent'),
		description: z.string().nullable().describe('Description of the agent. Null if not provided'),
		type: z
			.nativeEnum(RegistryEntryType)
			.describe('The agent access model. Standard for legacy/untyped entries; OpenApi or X402 otherwise'),
		apiBaseUrl: z
			.string()
			.nullable()
			.describe('Base URL of the agent API for interactions. Null for OpenApi/X402 agents'),
		openApiSpecUrl: z
			.string()
			.nullable()
			.describe('URL to the agent OpenAPI specification document. Null unless the agent is OpenApi-type'),
		x402ResourcesUrl: z
			.string()
			.nullable()
			.describe('URL to the agent x402 resource manifest JSON. Null unless the agent is X402-type'),
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
			.nullable()
			.describe('V1 legacy pricing. Null for V2 entries, whose pricing is owned by each supported payment source.'),
		sendFundingLovelace: z
			.string()
			.nullable()
			.describe(
				'Effective lovelace amount explicitly configured for the NFT output. Null means the default minimum NFT funding is used.',
			),
		supportedPaymentSources: supportedPaymentSourcesSchema
			.nullable()
			.describe('Payment sources advertised by this registry entry. Null for legacy metadata.'),
		verifications: verificationsSchema
			.nullable()
			.describe('KERI/Veridian verification claims advertised by this registry entry. Null when none.'),
		SmartContractWallet: z
			.object({
				walletVkey: z.string().describe('Payment key hash of the smart contract wallet'),
				walletAddress: z.string().describe('Cardano address of the smart contract wallet'),
			})
			.describe('Smart contract wallet managing this agent registration'),
		RecipientWallet: z
			.object({
				walletVkey: z.string().describe('Payment key hash of the managed recipient wallet'),
				walletAddress: z.string().describe('Cardano address of the managed recipient wallet'),
			})
			.nullable()
			.describe('Managed wallet that receives the registry NFT. Null when the minting wallet receives it'),
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
		.describe(
			'The smart contract address of the payment source. When omitted with no explicit payment source type, count defaults to Web3CardanoV1 for backwards compatibility. Supplying this field queries that exact V1 or V2 source.',
		),
	filterPaymentSourceType: z
		.nativeEnum(PaymentSourceType)
		.optional()
		.describe(
			'Filter by payment source type. When omitted with no smart-contract-address filter, count defaults to Web3CardanoV1 for backwards compatibility.',
		),
});

export const queryRegistryCountSchemaOutput = z.object({
	total: z.number().describe('Total number of AI agents'),
});

export const registerAgentSchemaInput = z.object({
	network: z.nativeEnum(Network).describe('The Cardano network used to register the agent on'),
	type: z
		.nativeEnum(RegistryEntryType)
		.optional()
		.describe(
			'The agent access model. Defaults to Standard when omitted (Standard emits no on-chain type field for backwards compatibility). Standard requires apiBaseUrl; OpenApi requires openApiSpecUrl; X402 advertises priced resources.',
		),
	sellingWalletVkey: z
		.string()
		.length(56)
		.regex(/^[0-9a-fA-F]{56}$/, 'sellingWalletVkey must be a 56-char hex blake2b-224 payment-key hash')
		.describe('The payment key of a specific wallet used for the registration'),
	recipientWalletAddress: z
		.string()
		.min(58)
		.max(120)
		.regex(/^(addr1|addr_test1)[0-9a-z]+$/, 'recipientWalletAddress must be a bech32 Cardano address')
		.optional()
		.describe(
			'Optional managed hot wallet address on the same payment source that should receive the minted registry NFT. If omitted, the minting wallet receives it.',
		),
	sendFundingLovelace: z
		.string()
		.regex(/^\d+$/)
		// Cardano max supply is ~45e15 lovelace (16 digits). Reject inputs
		// beyond what could ever exist on chain so downstream BigInt math
		// has a sane upper bound.
		.max(17)
		.optional()
		.describe(
			'Optional lovelace amount to include with the minted NFT output. If provided below the minimum NFT funding, the current minimum is still used.',
		),
	supportedPaymentSources: supportedPaymentSourcesSchema
		.optional()
		.describe('Required for V2 registrations and forbidden for V1 registrations. Every V2 source owns its pricing.'),
	verifications: verificationsSchema
		.optional()
		.describe(
			'Optional KERI/Veridian verification claims advertised in the registry metadata for independent third-party verification. Accepted on any registration; surfaced in the UI for V2 registries only.',
		),
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
	apiBaseUrl: z
		.string()
		.url()
		.max(250)
		.optional()
		.describe('Base URL of the agent, to request interactions. Required for Standard-type agents; omit for OpenApi/X402.'),
	openApiSpecUrl: z
		.string()
		.url()
		.max(250)
		.optional()
		.describe(
			'URL to the agent OpenAPI 3.1.x specification document (JSON or YAML). Required for OpenApi-type agents; omit for others.',
		),
	x402ResourcesUrl: z
		.string()
		.url()
		.max(250)
		.optional()
		.describe(
			'URL to the agent self-hosted x402 resource manifest (e.g. /.well-known/x402.json): a JSON document listing this agent resources, each { resource, type (http|mcp), inputSchema?, outputSchema? }. Payment stays agent-level (supportedPaymentSources), not per resource. Required for X402-type agents; omit for others.',
		),
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
						// Same bounds as the V2 source-owned pricing amounts: digits
						// only, positive, within Postgres BIGINT. The old bare
						// `.max(25)` let `BigInt()` throw a 500 on '1.5'/'abc' and
						// persisted negative or overlong values.
						amount: atomicAmountSchema.describe(
							'The quantity of the asset. Make sure to convert it from the underlying smallest unit (in case of decimals, multiply it by the decimal factor e.g. for 1 ADA = 1000000 lovelace)',
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
		.optional()
		.describe(
			'Required legacy pricing for V1 registrations and forbidden for V2 registrations. V2 pricing belongs inside supportedPaymentSources[].pricing.',
		),
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
}).superRefine((input, ctx) => {
	// Endpoint descriptor is per-type and mutually exclusive. Absent type ==
	// Standard. The V1/V2 pricing rules are an orthogonal axis enforced in the
	// route handler — payment is decoupled from the API access model.
	const entryType = input.type ?? RegistryEntryType.Standard;
	// [required endpoint field, the two that must be absent] per type.
	const endpointRules: Record<
		RegistryEntryType,
		{ required: 'apiBaseUrl' | 'openApiSpecUrl' | 'x402ResourcesUrl'; requiredLabel: string }
	> = {
		[RegistryEntryType.Standard]: { required: 'apiBaseUrl', requiredLabel: 'Standard agents require apiBaseUrl' },
		[RegistryEntryType.OpenApi]: { required: 'openApiSpecUrl', requiredLabel: 'OpenApi agents require openApiSpecUrl' },
		[RegistryEntryType.X402]: { required: 'x402ResourcesUrl', requiredLabel: 'X402 agents require x402ResourcesUrl' },
	};
	const { required, requiredLabel } = endpointRules[entryType];
	if (input[required] == null) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, path: [required], message: requiredLabel });
	}
	for (const field of ['apiBaseUrl', 'openApiSpecUrl', 'x402ResourcesUrl'] as const) {
		if (field !== required && input[field] != null) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: [field],
				message: `${field} is not valid for a ${entryType} agent; use ${required}`,
			});
		}
	}
});

export const registerAgentSchemaOutput = registryRequestOutputSchema;

export const deleteAgentRegistrationSchemaInput = z.object({
	id: z.string().cuid().describe('The database ID of the agent registration record to be deleted.'),
});

export const deleteAgentRegistrationSchemaOutput = registryRequestOutputSchema;
