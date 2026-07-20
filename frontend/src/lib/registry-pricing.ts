import type { RegistryEntry } from '@/lib/api/generated';

export type AgentPricingView =
  | {
      pricingType: 'Fixed';
      Pricing: Array<{ unit: string; amount: string }>;
    }
  | {
      pricingType: 'Dynamic' | 'Free';
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
 * Returns the Cardano pricing operators edit in the registration dialog.
 * V2 reads it from the selected source; V1 falls back to the legacy top-level
 * field. This keeps the compatibility field out of all V2 write payloads.
 */
export function getPrimaryCardanoPricing(agent: RegistryEntry): AgentPricingView | null {
  const cardanoSource = (agent.supportedPaymentSources ?? []).find(
    (source) => source.chain === 'Cardano',
  );
  if (cardanoSource) {
    const pricing = cardanoSource.pricing;
    if (pricing.pricingType === 'Fixed') {
      return {
        pricingType: 'Fixed',
        Pricing: pricing.fixed.map((price) => ({
          unit: price.asset,
          amount: price.amount,
        })),
      };
    }
    return { pricingType: pricing.pricingType };
  }

  return parseLegacyAgentPricing(agent.AgentPricing);
}
