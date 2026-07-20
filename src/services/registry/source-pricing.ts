import { PricingType, type Prisma } from '@/generated/prisma/client';
import {
	SupportedPaymentSourceChain,
	getSupportedPaymentSourceCanonicalKey,
	type SupportedPaymentSource,
	type SupportedPaymentSourcePricing,
} from '@/types/payment-source';

type LegacyAgentPricing =
	| {
			pricingType: typeof PricingType.Fixed;
			Pricing: Array<{ unit: string; amount: string }>;
	  }
	| { pricingType: typeof PricingType.Dynamic }
	| { pricingType: typeof PricingType.Free };

function normalizeCardanoAsset(asset: string): string {
	return asset.toLowerCase() === 'lovelace' ? '' : asset;
}

export function buildAgentPricingCreate(
	pricing: SupportedPaymentSourcePricing,
	chain: SupportedPaymentSource['chain'],
): Prisma.AgentPricingCreateWithoutSupportedPaymentSourceInput {
	if (pricing.pricingType !== PricingType.Fixed) {
		return { pricingType: pricing.pricingType };
	}

	return {
		pricingType: PricingType.Fixed,
		FixedPricing: {
			create: {
				Amounts: {
					createMany: {
						data: pricing.fixed.map((price) => ({
							unit:
								chain === SupportedPaymentSourceChain.EVM
									? price.asset.toLowerCase()
									: normalizeCardanoAsset(price.asset),
							amount: BigInt(price.amount),
						})),
					},
				},
			},
		},
	};
}

export function buildLegacyAgentPricingCreate(
	pricing: LegacyAgentPricing,
): Prisma.AgentPricingCreateWithoutRegistryRequestInput {
	if (pricing.pricingType !== PricingType.Fixed) {
		return { pricingType: pricing.pricingType };
	}

	return {
		pricingType: PricingType.Fixed,
		FixedPricing: {
			create: {
				Amounts: {
					createMany: {
						data: pricing.Pricing.map((price) => ({
							unit: normalizeCardanoAsset(price.unit),
							amount: BigInt(price.amount),
						})),
					},
				},
			},
		},
	};
}

export function buildSupportedPaymentSourceCreate(
	source: SupportedPaymentSource,
	position: number,
): Prisma.SupportedPaymentSourceCreateWithoutRegistryRequestInput {
	const common = {
		chain: source.chain,
		network: source.network,
		position,
		canonicalKey: getSupportedPaymentSourceCanonicalKey(source),
		Pricing: {
			create: buildAgentPricingCreate(source.pricing, source.chain),
		},
	};

	if (source.chain === SupportedPaymentSourceChain.Cardano) {
		return {
			...common,
			paymentSourceType: source.paymentSourceType,
			address: source.address,
		};
	}

	const fixedPrice = source.pricing.pricingType === PricingType.Fixed ? source.pricing.fixed[0] : undefined;
	const dynamicAsset = source.pricing.pricingType === PricingType.Dynamic ? source.pricing.dynamic?.[0] : undefined;

	return {
		...common,
		paymentSourceType: null,
		address: (source.address ?? source.payTo).toLowerCase(),
		scheme: source.scheme,
		payTo: source.payTo.toLowerCase(),
		resource: source.resource,
		extra: source.extra as Prisma.InputJsonValue | undefined,
		fixedDecimals: fixedPrice?.decimals,
		dynamicAsset: dynamicAsset?.asset.toLowerCase(),
		dynamicDecimals: dynamicAsset?.decimals,
	};
}

export function getCardanoFixedAssets(sources: SupportedPaymentSource[]): string[] {
	return sources.flatMap((source) =>
		source.chain === SupportedPaymentSourceChain.Cardano && source.pricing.pricingType === PricingType.Fixed
			? source.pricing.fixed.map((price) => price.asset)
			: [],
	);
}
