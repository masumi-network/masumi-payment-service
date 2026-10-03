import { PaymentSourceType, PricingType, RegistryEntryType, X402PaymentScheme } from '@/generated/prisma/client';
import { REGISTRY_ENTRY_ON_CHAIN_TYPE } from '@masumi/payment-core/registry-entry-type';
import { DEFAULTS } from '@masumi/payment-core/config';
import { stringToMetadata, cleanMetadata } from '@/utils/converter/metadata-string-convert';
import type { RegistryMetadata } from '../../../builders/batch-registry';
import { MAX_SUPPORTED_PAYMENT_SOURCES, SupportedPaymentSourceChain } from '@/types/payment-source';
import { verificationRowToApi, verificationsToMetadata, type AgentVerificationRow } from '@/types/verification';

type RegistrySupportedPaymentSourceMetadataRow = {
	chain: string;
	network: string;
	paymentSourceType: PaymentSourceType | null;
	address: string;
	scheme?: X402PaymentScheme | null;
	dynamicAsset?: string | null;
	dynamicDecimals?: number | null;
	fixedDecimals?: number | null;
	payTo?: string | null;
	resource?: string | null;
	extra?: unknown;
	Pricing: {
		pricingType: PricingType;
		FixedPricing?: {
			Amounts: Array<{ unit: string; amount: bigint }>;
		} | null;
	} | null;
};

export function validateRegistrationPricing(request: {
	Pricing: unknown;
	SupportedPaymentSources: RegistrySupportedPaymentSourceMetadataRow[];
}): void {
	if (request.Pricing != null) {
		throw new Error('V2 registry requests must not contain top-level AgentPricing');
	}
	if (request.SupportedPaymentSources.length === 0) {
		throw new Error('V2 registry requests require at least one supported payment source');
	}

	for (const [index, source] of request.SupportedPaymentSources.entries()) {
		if (source.Pricing == null) {
			throw new Error(`Supported payment source ${index + 1} is missing pricing`);
		}
		if (
			source.Pricing.pricingType !== PricingType.Fixed &&
			source.Pricing.pricingType !== PricingType.Free &&
			source.Pricing.pricingType !== PricingType.Dynamic
		) {
			throw new Error(`Supported payment source ${index + 1} has an unsupported pricing type`);
		}
		const amounts = source.Pricing.FixedPricing?.Amounts ?? [];
		if (source.Pricing.pricingType === PricingType.Fixed && amounts.length === 0) {
			throw new Error(`Supported payment source ${index + 1} has no fixed pricing amounts`);
		}
		if (source.Pricing.pricingType !== PricingType.Fixed && source.Pricing.FixedPricing != null) {
			throw new Error(`Supported payment source ${index + 1} has fixed amounts for non-fixed pricing`);
		}
		if (
			source.chain === SupportedPaymentSourceChain.EVM &&
			source.Pricing.pricingType === PricingType.Fixed &&
			(amounts.length !== 1 || source.fixedDecimals == null)
		) {
			throw new Error(`Fixed x402 payment source ${index + 1} requires one asset and decimals`);
		}
	}
}

export function buildAgentMetadata(request: {
	name: string;
	description: string | null;
	type: RegistryEntryType;
	apiBaseUrl: string | null;
	openApiSpecUrl: string | null;
	x402ResourcesUrl: string | null;
	/// A2A descriptors live in a 1:1 detail row; absent (null) for every other type.
	A2ADetail: { agentCardUrl: string; protocolVersions: string[] } | null;
	ExampleOutputs: Array<{ name: string; mimeType: string; url: string }>;
	capabilityName?: string | null;
	capabilityVersion?: string | null;
	authorName: string | null;
	authorContactEmail: string | null;
	authorContactOther: string | null;
	authorOrganization: string | null;
	privacyPolicy: string | null;
	terms: string | null;
	other: string | null;
	tags: string[];
	Pricing: unknown;
	metadataVersion: number;
	SupportedPaymentSources: RegistrySupportedPaymentSourceMetadataRow[];
	// Persisted AgentVerification rows; reshaped to nested form before emit.
	Verifications?: AgentVerificationRow[];
}): RegistryMetadata {
	const supportedPaymentSources = request.SupportedPaymentSources;
	if (supportedPaymentSources.length === 0) {
		throw new Error('Cannot register agent: V2 requires at least one supported payment source');
	}
	if (supportedPaymentSources.length > MAX_SUPPORTED_PAYMENT_SOURCES) {
		throw new Error(
			`Cannot register agent: ${supportedPaymentSources.length} payment sources exceed ` +
				`the on-chain maximum of ${MAX_SUPPORTED_PAYMENT_SOURCES}`,
		);
	}
	// Mirror the V1 builder's hard version guard: a V2 row carrying a V1
	// metadata version would gate off supported_payment_sources while V2 no
	// longer emits a top-level agentPricing block — minting a permanently
	// unpurchasable entry with no pricing at all. Fail the registration
	// instead. Only reachable via corrupt/hand-edited rows; the route always
	// writes the current version for V2.
	if (request.metadataVersion < DEFAULTS.DEFAULT_REGISTRY_METADATA_VERSION) {
		throw new Error(
			`Cannot register agent: V2 requires metadataVersion >= ${DEFAULTS.DEFAULT_REGISTRY_METADATA_VERSION}`,
		);
	}
	// Optional KERI/Veridian verification claims (see @masumi/payment-core/
	// verification). Gated on the same metadata version as supported_payment_sources
	// (a v2-metadata concept); self-describing on chain for third-party verification.
	const verificationRows = request.Verifications ?? [];
	const verificationsMetadata =
		request.metadataVersion >= DEFAULTS.DEFAULT_REGISTRY_METADATA_VERSION && verificationRows.length > 0
			? verificationsToMetadata(verificationRows.map(verificationRowToApi), stringToMetadata)
			: undefined;
	const metadata = {
		// Standard entries emit no `type` (undefined -> stripped by cleanMetadata)
		// so their metadata stays byte-identical to pre-type-discriminator mints.
		type: REGISTRY_ENTRY_ON_CHAIN_TYPE[request.type],
		name: stringToMetadata(request.name),
		description: stringToMetadata(request.description),
		// Null for OpenApi/X402 entries -> omitted by cleanMetadata.
		api_base_url: request.type === RegistryEntryType.A2A ? undefined : stringToMetadata(request.apiBaseUrl),
		api_url: request.type === RegistryEntryType.A2A ? stringToMetadata(request.apiBaseUrl) : undefined,
		// Set only for OpenApi entries; null otherwise -> omitted by cleanMetadata.
		openapi_spec_url: stringToMetadata(request.openApiSpecUrl),
		// Set only for X402 entries; null otherwise -> omitted by cleanMetadata.
		x402_resources_url: stringToMetadata(request.x402ResourcesUrl),
		// Set only for A2A entries (the detail row exists only for those); null/
		// undefined otherwise -> omitted by cleanMetadata. The versions array must be
		// `undefined` and never `[]` for non-A2A entries: cleanMetadata strips null and
		// undefined but WOULD emit an empty array, changing the minted bytes for every
		// other entry type.
		agent_card_url: stringToMetadata(request.A2ADetail?.agentCardUrl ?? null),
		a2a_protocol_versions:
			request.A2ADetail != null && request.A2ADetail.protocolVersions.length > 0
				? request.A2ADetail.protocolVersions
				: undefined,
		example_output: request.ExampleOutputs.map((exampleOutput) => ({
			name: stringToMetadata(exampleOutput.name),
			mime_type: stringToMetadata(exampleOutput.mimeType),
			url: stringToMetadata(exampleOutput.url),
		})),
		capability:
			request.capabilityName && request.capabilityVersion
				? {
						name: stringToMetadata(request.capabilityName),
						version: stringToMetadata(request.capabilityVersion),
					}
				: undefined,
		author: {
			name: stringToMetadata(request.authorName),
			contact_email: stringToMetadata(request.authorContactEmail),
			contact_other: stringToMetadata(request.authorContactOther),
			organization: stringToMetadata(request.authorOrganization),
		},
		legal: {
			privacy_policy: stringToMetadata(request.privacyPolicy),
			terms: stringToMetadata(request.terms),
			other: stringToMetadata(request.other),
		},
		tags: request.tags,
		image: stringToMetadata(DEFAULTS.DEFAULT_IMAGE),
		metadata_version:
			request.type === RegistryEntryType.A2A ? request.metadataVersion : request.metadataVersion.toString(),
		supported_payment_sources:
			request.metadataVersion >= DEFAULTS.DEFAULT_REGISTRY_METADATA_VERSION
				? supportedPaymentSources.map((source) => {
						if (source.Pricing == null) {
							throw new Error('Cannot register agent: supported payment source pricing is missing');
						}
						const fixedAmounts = source.Pricing.FixedPricing?.Amounts ?? [];
						// Completeness checks run BEFORE the pricing object is built so a
						// missing decimals value can never be stringified into emitted
						// metadata as the literal "null".
						if (source.chain === SupportedPaymentSourceChain.EVM) {
							if (source.payTo == null) {
								throw new Error('Cannot register agent: x402 supported payment source is incomplete');
							}
							if (
								source.Pricing.pricingType === PricingType.Fixed &&
								(fixedAmounts.length !== 1 || source.fixedDecimals == null)
							) {
								throw new Error('Cannot register agent: fixed x402 pricing is incomplete');
							}
							if (
								source.Pricing.pricingType === PricingType.Dynamic &&
								(source.dynamicAsset == null) !== (source.dynamicDecimals == null)
							) {
								throw new Error('Cannot register agent: dynamic x402 pricing is incomplete');
							}
							if (
								source.Pricing.pricingType === PricingType.Free &&
								(source.dynamicAsset != null ||
									source.dynamicDecimals != null ||
									source.fixedDecimals != null ||
									fixedAmounts.length > 0)
							) {
								throw new Error('Cannot register agent: free x402 pricing must not include an asset or amount');
							}
						}
						const pricing =
							source.Pricing.pricingType === PricingType.Fixed
								? {
										pricingType: PricingType.Fixed,
										fixed: fixedAmounts.map((amount) => ({
											asset: stringToMetadata(amount.unit, false),
											amount: amount.amount.toString(),
											...(source.chain === SupportedPaymentSourceChain.EVM
												? { decimals: String(source.fixedDecimals) }
												: {}),
										})),
									}
								: source.Pricing.pricingType === PricingType.Dynamic &&
									  source.chain === SupportedPaymentSourceChain.EVM &&
									  source.dynamicAsset != null
									? {
											pricingType: PricingType.Dynamic,
											dynamic: [
												{
													asset: stringToMetadata(source.dynamicAsset, false),
													decimals: String(source.dynamicDecimals),
												},
											],
										}
									: { pricingType: source.Pricing.pricingType };

						if (source.chain === SupportedPaymentSourceChain.EVM) {
							return {
								chain: stringToMetadata(source.chain),
								network: stringToMetadata(String(source.network)),
								settlement: {
									scheme: stringToMetadata(source.scheme ?? X402PaymentScheme.Exact),
									payTo: stringToMetadata(source.payTo),
									resource: stringToMetadata(source.resource),
									// Prisma represents an omitted nullable JSON field as null.
									// Cardano metadata has no null value, so omit it before Mesh
									// recursively converts this object to metadatum.
									extra: source.extra ?? undefined,
								},
								pricing,
							};
						}
						return {
							chain: stringToMetadata(source.chain),
							network: stringToMetadata(String(source.network)),
							settlement: {
								paymentSourceType:
									source.paymentSourceType != null ? stringToMetadata(source.paymentSourceType) : undefined,
								address: stringToMetadata(source.address),
							},
							pricing,
						};
					})
				: undefined,
		verifications: verificationsMetadata,
	};
	return cleanMetadata(metadata) as RegistryMetadata;
}
