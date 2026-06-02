import { Network, PricingType, X402PaymentScheme, type Prisma } from '@/generated/prisma/client';
import { SupportedPaymentSourceChain, type SupportedPaymentSource } from '@/types/payment-source';
import createHttpError from 'http-errors';
import type { RegistryListRecord } from './queries';

type SupportedPaymentSourceRecord = RegistryListRecord['SupportedPaymentSources'][number];

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
	return sources.map((source) => {
		if (source.chain === SupportedPaymentSourceChain.EVM) {
			if (
				source.scheme !== X402PaymentScheme.Exact ||
				source.asset == null ||
				source.amount == null ||
				source.decimals == null ||
				source.payTo == null
			) {
				throw createHttpError(500, 'Persisted x402 supported payment source is incomplete');
			}
			return {
				chain: SupportedPaymentSourceChain.EVM,
				network: source.network,
				paymentSourceType: null,
				address: source.address,
				scheme: 'Exact',
				asset: source.asset,
				amount: source.amount.toString(),
				decimals: source.decimals,
				payTo: source.payTo,
				resource: source.resource ?? undefined,
				extra: jsonObjectToRecord(source.extra),
			};
		}

		if (source.paymentSourceType == null) {
			throw createHttpError(500, 'Persisted Cardano supported payment source is missing its paymentSourceType');
		}
		return {
			chain: SupportedPaymentSourceChain.Cardano,
			network: source.network as Network,
			paymentSourceType: source.paymentSourceType,
			address: source.address,
		};
	});
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
		AgentPricing:
			item.Pricing.pricingType == PricingType.Fixed
				? {
						pricingType: PricingType.Fixed,
						Pricing:
							item.Pricing.FixedPricing?.Amounts.map((price) => ({
								unit: price.unit,
								amount: price.amount.toString(),
							})) ?? [],
					}
				: {
						pricingType: item.Pricing.pricingType,
					},
		sendFundingLovelace: item.sendFundingLovelace?.toString() ?? null,
		supportedPaymentSources: serializeSupportedPaymentSources(item.SupportedPaymentSources),
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
