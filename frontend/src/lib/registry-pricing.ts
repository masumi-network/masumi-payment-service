import type { RegistryEntry } from '@/lib/api/generated';

export type AgentPricingView =
  | {
      pricingType: 'Fixed';
      Pricing: Array<{ unit: string; amount: string }>;
    }
  | {
      pricingType: 'Dynamic' | 'Free';
    };

export type CardanoPricingOption = {
  pricing: AgentPricingView;
  supportedPaymentSourceIndex?: number;
  address?: string;
};

type UnknownAgentPricing = {
  pricingType?: unknown;
  Pricing?: unknown;
};

type UnknownFixedPrice = {
  unit?: unknown;
  amount?: unknown;
};

function isAgentPricing(value: unknown): value is UnknownAgentPricing {
  return typeof value === 'object' && value !== null;
}

function isFixedPrice(value: unknown): value is UnknownFixedPrice {
  return typeof value === 'object' && value !== null;
}

export function parseLegacyAgentPricing(value: unknown): AgentPricingView | null {
  if (!isAgentPricing(value)) return null;
  if (value.pricingType === 'Dynamic' || value.pricingType === 'Free') {
    return { pricingType: value.pricingType };
  }
  if (value.pricingType !== 'Fixed' || !Array.isArray(value.Pricing)) return null;

  if (value.Pricing.length === 0) return null;

  const pricing: Array<{ unit: string; amount: string }> = [];
  for (const price of value.Pricing) {
    if (
      !isFixedPrice(price) ||
      typeof price.unit !== 'string' ||
      typeof price.amount !== 'string'
    ) {
      return null;
    }
    pricing.push({ unit: price.unit, amount: price.amount });
  }
  return { pricingType: 'Fixed', Pricing: pricing };
}

/**
 * Returns every independently-priced Cardano option advertised by an agent.
 * V2 preserves the source's metadata-array index because the payment endpoint
 * requires that exact index. V1 has one legacy top-level pricing option.
 */
export function getCardanoPricingOptions(agent: RegistryEntry): CardanoPricingOption[] {
  if (agent.supportedPaymentSources != null) {
    return agent.supportedPaymentSources.flatMap((source, index) => {
      if (source.chain !== 'Cardano') return [];

      const pricing: AgentPricingView =
        source.pricing.pricingType === 'Fixed'
          ? {
              pricingType: 'Fixed',
              Pricing: source.pricing.fixed.map((price) => ({
                unit: price.asset,
                amount: price.amount,
              })),
            }
          : { pricingType: source.pricing.pricingType };

      return [
        {
          pricing,
          supportedPaymentSourceIndex: index,
          address: source.address,
        },
      ];
    });
  }

  const legacyPricing = parseLegacyAgentPricing(agent.AgentPricing);
  return legacyPricing ? [{ pricing: legacyPricing }] : [];
}

/**
 * Returns the Cardano pricing operators edit in the registration dialog.
 * V2 reads it from the selected source; V1 falls back to the legacy top-level
 * field. This keeps the compatibility field out of all V2 write payloads.
 */
export function getPrimaryCardanoPricing(agent: RegistryEntry): AgentPricingView | null {
  return getCardanoPricingOptions(agent)[0]?.pricing ?? null;
}
