import { z } from '@/utils/zod-openapi';
import { PricingType } from '@/generated/prisma/client';

export const agentMetadataObjectSchema = z.object({
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
		.describe('List of example outputs from the agent'),
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
		.describe('Author information for the agent'),
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
		.describe('Pricing information for the agent'),
	image: z.string().max(250).describe('URL to the agent image/logo'),
	metadataVersion: z.coerce
		.number()
		.int()
		.min(1)
		.max(1)
		.describe('Version of the metadata schema (currently only version 1 is supported)'),
});

export type AgentMetadataObject = z.infer<typeof agentMetadataObjectSchema>;
