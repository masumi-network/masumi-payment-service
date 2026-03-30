import { PricingType } from '@/generated/prisma/client';
import type { RegistryListRecord } from './queries';

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
