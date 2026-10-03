import { PaymentSourceType, PricingType } from '@/generated/prisma/client';
import { metadataToString } from '@/utils/converter/metadata-string-convert';
import type { Network } from '@/generated/prisma/client';
import {
	isCardanoAddressForNetwork,
	SupportedPaymentSourceChain,
	parseSupportedPaymentSourcesFromMetadata,
	supportedPaymentSourceMetadataSchema,
	type SupportedPaymentSource,
} from '@/types/payment-source';
import { parseVerificationsFromMetadata, verificationMetadataSchema } from '@/types/verification';
import { z } from '@masumi/payment-core/zod';
import { a2aProtocolVersionSchema } from '@/utils/validator/a2a-protocol-version';

/** CIP-25 text: single string or multiple <64-byte chunks joined by {@link metadataToString}. */
const cip25String = z
	.string()
	.min(1)
	.or(z.array(z.string().min(1)).min(1));

/** Fields shared by Standard, OpenApi, and X402 registry metadata (CIP-25 on-chain). */
const metadataBaseSchema = z.object({
	name: cip25String,
	description: z.string().or(z.array(z.string())).optional(),
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
		name: cip25String,
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
						amount: z.coerce.bigint().refine((amount) => amount > 0n, 'Amount must be greater than zero'),
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
		)
		.or(
			z.object({
				pricingType: z.enum([PricingType.Dynamic]),
			}),
		)
		.optional(),
	image: z.string().or(z.array(z.string())),
	metadata_version: z.coerce.number().int().min(1).max(2),
	supported_payment_sources: z.array(supportedPaymentSourceMetadataSchema).optional(),
	verifications: z.array(verificationMetadataSchema).optional(),
	type: z
		.string()
		.or(z.array(z.string()))
		.refine((type) => metadataToString(type) !== 'a2aV1', 'A2A metadata requires its endpoint descriptor')
		.optional(),
});

const standardRegistryMetadataSchema = metadataBaseSchema.extend({
	api_base_url: cip25String,
});

const openApiRegistryMetadataSchema = metadataBaseSchema.extend({
	openapi_spec_url: cip25String,
});

const x402RegistryMetadataSchema = metadataBaseSchema.extend({
	x402_resources_url: cip25String,
});

const a2aRegistryMetadataSchema = metadataBaseSchema
	.extend({
		type: cip25String.refine((type) => metadataToString(type) === 'a2aV1'),
		api_url: cip25String.optional(),
		api_base_url: cip25String.optional(),
		agent_card_url: cip25String,
		a2a_protocol_versions: z.array(a2aProtocolVersionSchema).min(1),
		metadata_version: z.coerce.number().int().min(2).max(2),
	})
	.superRefine((metadata, ctx) => {
		const apiUrl = metadataToString(metadata.api_url);
		const apiBaseUrl = metadataToString(metadata.api_base_url);
		if (apiUrl == null && apiBaseUrl == null)
			ctx.addIssue({ code: 'custom', path: ['api_url'], message: 'Agent API URL is required' });
		if (apiUrl != null && apiBaseUrl != null && apiUrl !== apiBaseUrl)
			ctx.addIssue({ code: 'custom', path: ['api_url'], message: 'A2A API URL fields conflict' });
	});

/**
 * On-chain registry metadata. Standard MIP agents use `api_base_url`; OpenApi and X402
 * entries omit it and use `openapi_spec_url` or `x402_resources_url` instead (see V2 mint).
 */
export const metadataSchema = z.union([
	a2aRegistryMetadataSchema,
	standardRegistryMetadataSchema,
	openApiRegistryMetadataSchema,
	x402RegistryMetadataSchema,
]);

export type ParsedRegistryMetadata = z.infer<typeof metadataSchema>;

type MetadataAgentPricing = NonNullable<ParsedRegistryMetadata['agentPricing']>;

export function resolveRegistryInteractionUrl(parsed: ParsedRegistryMetadata): string | null {
	if (metadataToString(parsed.type) === 'a2aV1') {
		return (
			metadataToString('api_url' in parsed ? parsed.api_url : undefined) ??
			metadataToString('api_base_url' in parsed ? parsed.api_base_url : undefined) ??
			null
		);
	}
	const url =
		metadataToString('api_base_url' in parsed ? parsed.api_base_url : undefined) ??
		metadataToString('x402_resources_url' in parsed ? parsed.x402_resources_url : undefined) ??
		metadataToString('openapi_spec_url' in parsed ? parsed.openapi_spec_url : undefined);
	return url ?? null;
}

export function resolveRegistryEntryTypeApi(parsed: ParsedRegistryMetadata): 'Standard' | 'OpenApi' | 'X402' | 'A2A' {
	const onChainType = metadataToString(parsed.type);
	if (onChainType === 'a2aV1') return 'A2A';
	if (onChainType === 'x402V1' || 'x402_resources_url' in parsed) {
		return 'X402';
	}
	if (onChainType === 'OpenAPI' || 'openapi_spec_url' in parsed) {
		return 'OpenApi';
	}
	return 'Standard';
}

export function isRegistryMetadataAllowedForPaymentSource(
	parsed: ParsedRegistryMetadata,
	paymentSourceType: PaymentSourceType,
): boolean {
	return resolveRegistryEntryTypeApi(parsed) !== 'A2A' || paymentSourceType === PaymentSourceType.Web3CardanoV2;
}

export function resolveAgentPricingFromMetadata(
	parsed: Pick<ParsedRegistryMetadata, 'agentPricing' | 'supported_payment_sources'>,
	supportedPaymentSourceIndex?: number,
): MetadataAgentPricing | null {
	const cardanoSource =
		supportedPaymentSourceIndex == null
			? parsed.supported_payment_sources?.find(
					(source) => metadataToString(source.chain) === SupportedPaymentSourceChain.Cardano,
				)
			: parsed.supported_payment_sources?.[supportedPaymentSourceIndex];
	if (supportedPaymentSourceIndex != null && cardanoSource == null) {
		return null;
	}
	if (cardanoSource != null && metadataToString(cardanoSource.chain) !== SupportedPaymentSourceChain.Cardano) {
		return null;
	}
	const sourcePricing = cardanoSource?.pricing;
	if (sourcePricing != null) {
		const pricingType = metadataToString(sourcePricing.pricingType);
		if (pricingType === PricingType.Fixed) {
			const fixedPricing: Array<{ amount: bigint; unit: string | string[] }> = [];
			for (const entry of sourcePricing.fixed ?? []) {
				const amount = metadataToString(entry.amount);
				if (amount == null || !/^\d+$/.test(amount)) {
					return null;
				}
				fixedPricing.push({ amount: BigInt(amount), unit: entry.asset });
			}
			return {
				pricingType: PricingType.Fixed,
				fixedPricing,
			};
		}
		if (pricingType === PricingType.Free) return { pricingType: PricingType.Free };
		if (pricingType === PricingType.Dynamic) return { pricingType: PricingType.Dynamic };
		return null;
	}
	return parsed.agentPricing ?? null;
}

export type RegistryMetadataApiShape = {
	name: string;
	description: string | null | undefined;
	apiBaseUrl: string;
	type: 'Standard' | 'OpenApi' | 'X402' | 'A2A';
	a2aAgentCardUrl?: string;
	a2aProtocolVersions?: string[];
	openApiSpecUrl: string | undefined;
	x402ResourcesUrl: string | undefined;
	ExampleOutputs: Array<{ name: string; mimeType: string; url: string }>;
	Capability:
		| {
				name: string;
				version: string;
		  }
		| undefined;
	Author: {
		name: string;
		contactEmail: string | null | undefined;
		contactOther: string | null | undefined;
		organization: string | null | undefined;
	};
	Legal:
		| {
				privacyPolicy: string | null | undefined;
				terms: string | null | undefined;
				other: string | null | undefined;
		  }
		| undefined;
	Tags: string[];
	AgentPricing:
		| {
				pricingType: Extract<PricingType, 'Fixed'>;
				Pricing: Array<{ amount: string; unit: string }>;
		  }
		| {
				pricingType: Extract<PricingType, 'Free' | 'Dynamic'>;
		  }
		| null;
	image: string;
	metadataVersion: number;
	supportedPaymentSources: ReturnType<typeof parseSupportedPaymentSourcesFromMetadata>;
	verifications: ReturnType<typeof parseVerificationsFromMetadata>;
};

function filterValidSupportedPaymentSources(
	sources: SupportedPaymentSource[] | null,
	expectedNetwork: Network,
): SupportedPaymentSource[] | null {
	if (sources == null) return null;
	return sources.filter((source) => {
		if (source.chain === SupportedPaymentSourceChain.EVM) {
			return true;
		}
		return source.network === expectedNetwork && isCardanoAddressForNetwork(source.address, expectedNetwork);
	});
}

export function mapParsedRegistryMetadataToApi(
	parsed: ParsedRegistryMetadata,
	options: { filterPaymentSourcesForNetwork?: Network } = {},
): RegistryMetadataApiShape | null {
	const interactionUrl = resolveRegistryInteractionUrl(parsed);
	if (interactionUrl == null) {
		return null;
	}

	const resolvedAgentPricing = resolveAgentPricingFromMetadata(parsed);
	const entryType = resolveRegistryEntryTypeApi(parsed);

	const parsedSources = parseSupportedPaymentSourcesFromMetadata(parsed.supported_payment_sources);
	const filteredSources =
		options.filterPaymentSourcesForNetwork != null
			? filterValidSupportedPaymentSources(parsedSources, options.filterPaymentSourcesForNetwork)
			: parsedSources;

	return {
		name: metadataToString(parsed.name)!,
		description: metadataToString(parsed.description),
		apiBaseUrl: interactionUrl,
		type: entryType,
		...(entryType === 'A2A'
			? {
					a2aAgentCardUrl:
						'agent_card_url' in parsed ? (metadataToString(parsed.agent_card_url) ?? undefined) : undefined,
					a2aProtocolVersions: 'a2a_protocol_versions' in parsed ? (parsed.a2a_protocol_versions ?? []) : [],
				}
			: {}),
		openApiSpecUrl: 'openapi_spec_url' in parsed ? (metadataToString(parsed.openapi_spec_url) ?? undefined) : undefined,
		x402ResourcesUrl:
			'x402_resources_url' in parsed ? (metadataToString(parsed.x402_resources_url) ?? undefined) : undefined,
		ExampleOutputs:
			parsed.example_output?.map((exampleOutput) => ({
				name: metadataToString(exampleOutput.name)!,
				mimeType: metadataToString(exampleOutput.mime_type)!,
				url: metadataToString(exampleOutput.url)!,
			})) ?? [],
		Capability: parsed.capability
			? {
					name: metadataToString(parsed.capability.name)!,
					version: metadataToString(parsed.capability.version)!,
				}
			: undefined,
		Author: {
			name: metadataToString(parsed.author.name)!,
			contactEmail: metadataToString(parsed.author.contact_email),
			contactOther: metadataToString(parsed.author.contact_other),
			organization: metadataToString(parsed.author.organization),
		},
		Legal: parsed.legal
			? {
					privacyPolicy: metadataToString(parsed.legal.privacy_policy),
					terms: metadataToString(parsed.legal.terms),
					other: metadataToString(parsed.legal.other),
				}
			: undefined,
		Tags: parsed.tags.map((tag) => metadataToString(tag)!),
		AgentPricing:
			parsed.metadata_version >= 2 || resolvedAgentPricing == null
				? null
				: resolvedAgentPricing.pricingType == PricingType.Fixed
					? {
							pricingType: resolvedAgentPricing.pricingType,
							Pricing: resolvedAgentPricing.fixedPricing.map((price) => ({
								amount: price.amount.toString(),
								unit: metadataToString(price.unit)!,
							})),
						}
					: {
							pricingType: resolvedAgentPricing.pricingType,
						},
		image: metadataToString(parsed.image)!,
		metadataVersion: parsed.metadata_version,
		supportedPaymentSources: filteredSources,
		verifications: parseVerificationsFromMetadata(parsed.verifications),
	};
}
