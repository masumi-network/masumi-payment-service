import { Network, PricingType, X402PaymentScheme, type Prisma } from '@/generated/prisma/client';
import { SupportedPaymentSourceChain, type SupportedPaymentSource } from '@/types/payment-source';
import {
	verificationRowToApi,
	verificationsSchema,
	type AgentVerificationRow,
	type Verification,
} from '@/types/verification';
import { logger } from '@masumi/payment-core/logger';
import type { RegistryListRecord } from './queries';

type SupportedPaymentSourceRecord = RegistryListRecord['SupportedPaymentSources'][number];
type LegacyAgentPricingRecord = {
	pricingType: PricingType;
	FixedPricing: {
		Amounts: Array<{ unit: string; amount: bigint }>;
	} | null;
} | null;

function jsonObjectToRecord(value: Prisma.JsonValue | null): Prisma.JsonObject | undefined {
	if (value != null && typeof value === 'object' && !Array.isArray(value)) {
		return value;
	}
	return undefined;
}

export function serializeSupportedPaymentSources(
	sources: SupportedPaymentSourceRecord[],
): SupportedPaymentSource[] | null {
	if (sources.length === 0) return null;
	// Persisted sources are authoritative V2 payment options. Never silently
	// remove a malformed row: doing so changes the advertised rails and shifts
	// their position-based selection indexes.
	const serialized = [...sources]
		.sort((left, right) => left.position - right.position)
		.flatMap((source): SupportedPaymentSource[] => {
			if (source.Pricing == null) {
				throw new Error(
					`Persisted payment source ${source.position} on ${source.network} is missing source-owned pricing`,
				);
			}

			const amounts = source.Pricing.FixedPricing?.Amounts ?? [];
			if (source.chain === SupportedPaymentSourceChain.EVM) {
				if (source.scheme !== X402PaymentScheme.Exact || source.payTo == null) {
					throw new Error(
						`Persisted x402 payment source ${source.position} on ${source.network} has incomplete settlement`,
					);
				}
				const base = {
					chain: SupportedPaymentSourceChain.EVM,
					network: source.network,
					paymentSourceType: null,
					address: source.address,
					scheme: 'Exact' as const,
					payTo: source.payTo,
					resource: source.resource ?? undefined,
					extra: jsonObjectToRecord(source.extra),
				};
				if (source.Pricing.pricingType === PricingType.Fixed) {
					const [price] = amounts;
					if (amounts.length !== 1 || price == null || source.fixedDecimals == null) {
						throw new Error(
							`Persisted fixed x402 payment source ${source.position} on ${source.network} requires one asset and decimals`,
						);
					}
					return [
						{
							...base,
							pricing: {
								pricingType: PricingType.Fixed,
								fixed: [
									{
										asset: price.unit,
										amount: price.amount.toString(),
										decimals: source.fixedDecimals,
									},
								],
							},
						},
					];
				}
				if (source.Pricing.pricingType === PricingType.Dynamic) {
					if ((source.dynamicAsset == null) !== (source.dynamicDecimals == null) || amounts.length > 0) {
						throw new Error(
							`Persisted dynamic x402 payment source ${source.position} on ${source.network} has inconsistent asset constraints`,
						);
					}
					return [
						{
							...base,
							pricing: {
								pricingType: PricingType.Dynamic,
								...(source.dynamicAsset != null && source.dynamicDecimals != null
									? {
											dynamic: [
												{
													asset: source.dynamicAsset,
													decimals: source.dynamicDecimals,
												},
											],
										}
									: {}),
							},
						},
					];
				}
				if (
					source.Pricing.pricingType === PricingType.Free &&
					source.dynamicAsset == null &&
					source.dynamicDecimals == null &&
					source.fixedDecimals == null &&
					amounts.length === 0
				) {
					return [{ ...base, pricing: { pricingType: PricingType.Free } }];
				}
				throw new Error(`Persisted x402 payment source ${source.position} on ${source.network} has malformed pricing`);
			}

			if (source.paymentSourceType == null) {
				throw new Error(
					`Persisted Cardano payment source ${source.position} on ${source.network} is missing paymentSourceType`,
				);
			}
			return [
				{
					chain: SupportedPaymentSourceChain.Cardano,
					network: source.network as Network,
					paymentSourceType: source.paymentSourceType,
					address: source.address,
					pricing:
						source.Pricing.pricingType === PricingType.Fixed
							? {
									pricingType: PricingType.Fixed,
									fixed: amounts.map((price) => ({
										asset: price.unit,
										amount: price.amount.toString(),
									})),
								}
							: { pricingType: source.Pricing.pricingType },
				},
			];
		});
	return serialized.length === 0 ? null : serialized;
}

export function serializeLegacyAgentPricing(pricing: LegacyAgentPricingRecord) {
	if (pricing == null) return null;
	return pricing.pricingType === PricingType.Fixed
		? {
				pricingType: PricingType.Fixed,
				Pricing:
					pricing.FixedPricing?.Amounts.map((price) => ({
						unit: price.unit,
						amount: price.amount.toString(),
					})) ?? [],
			}
		: { pricingType: pricing.pricingType };
}

// Reassemble persisted AgentVerification rows into the nested API shape. Re-validate
// and drop (with a log) rather than 500 the page if a row is somehow malformed —
// same defensive posture as supported payment sources.
export function serializeVerifications(rows: AgentVerificationRow[] | null | undefined): Verification[] | null {
	if (rows == null || rows.length === 0) return null;
	const parsed = verificationsSchema.safeParse(rows.map(verificationRowToApi));
	if (!parsed.success) {
		logger.error('Skipping malformed persisted verifications');
		return null;
	}
	return parsed.data;
}

export function serializeRegistryEntry(item: RegistryListRecord) {
	return {
		...item,
		Capability: {
			name: item.capabilityName,
			version: item.capabilityVersion,
		},
		Author: {
			name: item.authorName,
			contactEmail: item.authorContactEmail,
			contactOther: item.authorContactOther,
			organization: item.authorOrganization,
		},
		Legal: {
			privacyPolicy: item.privacyPolicy,
			terms: item.terms,
			other: item.other,
		},
		AgentPricing: serializeLegacyAgentPricing(item.Pricing),
		sendFundingLovelace: item.sendFundingLovelace?.toString() ?? null,
		supportedPaymentSources: serializeSupportedPaymentSources(item.SupportedPaymentSources),
		verifications: serializeVerifications(item.Verifications),
		Tags: item.tags,
		CurrentTransaction: item.CurrentTransaction
			? {
					...item.CurrentTransaction,
					fees: item.CurrentTransaction.fees?.toString() ?? null,
				}
			: null,
	};
}

export function serializeRegistryEntriesResponse(entries: RegistryListRecord[]) {
	return {
		Assets: entries.map(serializeRegistryEntry),
	};
}
