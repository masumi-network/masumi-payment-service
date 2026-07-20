import type { RegistryEntry } from '@/lib/api/generated';
import { POSTGRES_BIGINT_MAX } from '@/lib/registry-validation';

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
 * Pre-flight check that a V1 agent's legacy pricing can be re-registered as
 * V2 source-owned pricing. Mirrors the backend's `atomicAmountSchema`
 * (digits-only, > 0, <= int64 max): V1 metadata can hold 0 / decimal / junk
 * amounts that V2 rejects, and validating up front lets the migration dialog
 * flag offenders before starting a multi-transaction run instead of failing
 * mid-batch. Returns an error message, or null when migratable.
 */
export function validateLegacyPricingForV2Migration(agentPricing: unknown): string | null {
  const legacyPricing = parseLegacyAgentPricing(agentPricing);
  if (!legacyPricing) {
    return 'V1 pricing is missing or invalid';
  }
  if (legacyPricing.pricingType !== 'Fixed') return null;
  for (const price of legacyPricing.Pricing) {
    if (!/^\d{1,19}$/.test(price.amount)) {
      return `price amount "${price.amount}" is not a positive whole number of base units`;
    }
    const amount = BigInt(price.amount);
    if (amount <= BigInt(0) || amount > POSTGRES_BIGINT_MAX) {
      return `price amount "${price.amount}" must be between 1 and ${POSTGRES_BIGINT_MAX.toString()}`;
    }
  }
  return null;
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
