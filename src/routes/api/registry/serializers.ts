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
	// Skip (and log) incomplete persisted rows rather than throwing: this runs inside the
	// list serializer, so one malformed row must not fail the entire page with a 500.
	const serialized = sources.flatMap((source): SupportedPaymentSource[] => {
		if (source.chain === SupportedPaymentSourceChain.EVM) {
			if (
				source.scheme !== X402PaymentScheme.Exact ||
				source.asset == null ||
				source.amount == null ||
				source.decimals == null ||
				source.payTo == null
			) {
				logger.error('Skipping incomplete persisted x402 supported payment source', {
					network: source.network,
					address: source.address,
				});
				return [];
			}
			return [
				{
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
				},
			];
		}

		if (source.paymentSourceType == null) {
			logger.error('Skipping persisted Cardano supported payment source missing its paymentSourceType', {
				network: source.network,
				address: source.address,
			});
			return [];
		}
		return [
			{
				chain: SupportedPaymentSourceChain.Cardano,
				network: source.network as Network,
				paymentSourceType: source.paymentSourceType,
				address: source.address,
			},
		];
	});
	return serialized.length === 0 ? null : serialized;
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
