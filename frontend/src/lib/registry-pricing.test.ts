import assert from 'node:assert/strict';
import test from 'node:test';
import type { RegistryEntry } from '@/lib/api/generated';
import {
  getCardanoPricingOptions,
  getPrimaryCardanoPricing,
  parseLegacyAgentPricing,
  validateLegacyPricingForV2Migration,
} from './registry-pricing';

test('V2 reads pricing from the first Cardano source instead of AgentPricing', () => {
  const agent = {
    AgentPricing: null,
    supportedPaymentSources: [
      {
        chain: 'EVM',
        pricing: { pricingType: 'Dynamic' },
      },
      {
        chain: 'Cardano',
        pricing: {
          pricingType: 'Fixed',
          fixed: [{ asset: '', amount: '500000' }],
        },
      },
    ],
  } as unknown as RegistryEntry;

  assert.deepEqual(getPrimaryCardanoPricing(agent), {
    pricingType: 'Fixed',
    Pricing: [{ unit: '', amount: '500000' }],
  });
});

test('V1 falls back to top-level AgentPricing', () => {
  const agent = {
    AgentPricing: { pricingType: 'Dynamic' },
    supportedPaymentSources: null,
  } as unknown as RegistryEntry;

  assert.deepEqual(getPrimaryCardanoPricing(agent), {
    pricingType: 'Dynamic',
  });
});

test('malformed legacy pricing is rejected rather than partially accepted', () => {
  assert.equal(
    parseLegacyAgentPricing({
      pricingType: 'Fixed',
      Pricing: [{ unit: '', amount: 500000 }],
    }),
    null,
  );
});

test('migration pre-flight mirrors the V2 atomic amount rules', () => {
  // Non-Fixed pricing carries no amounts and always migrates.
  assert.equal(validateLegacyPricingForV2Migration({ pricingType: 'Dynamic' }), null);
  assert.equal(
    validateLegacyPricingForV2Migration({
      pricingType: 'Fixed',
      Pricing: [{ unit: 'lovelace', amount: '500000' }],
    }),
    null,
  );
  // Missing / malformed legacy pricing is flagged up front.
  assert.equal(validateLegacyPricingForV2Migration(null), 'V1 pricing is missing or invalid');
  // Zero, decimal, and out-of-range amounts fail V2's atomicAmountSchema.
  assert.match(
    validateLegacyPricingForV2Migration({
      pricingType: 'Fixed',
      Pricing: [{ unit: '', amount: '0' }],
    }) ?? '',
    /between 1 and 9223372036854775807/,
  );
  assert.match(
    validateLegacyPricingForV2Migration({
      pricingType: 'Fixed',
      Pricing: [{ unit: '', amount: '1.5' }],
    }) ?? '',
    /not a positive whole number/,
  );
  assert.match(
    validateLegacyPricingForV2Migration({
      pricingType: 'Fixed',
      Pricing: [{ unit: '', amount: '9223372036854775808' }],
    }) ?? '',
    /between 1 and 9223372036854775807/,
  );
});

test('V2 exposes all Cardano pricing options with their original source indexes', () => {
  const agent = {
    AgentPricing: null,
    supportedPaymentSources: [
      {
        chain: 'EVM',
        pricing: { pricingType: 'Dynamic' },
      },
      {
        chain: 'Cardano',
        address: 'addr_test1_dynamic',
        pricing: { pricingType: 'Dynamic' },
      },
      {
        chain: 'Cardano',
        address: 'addr_test1_free',
        pricing: { pricingType: 'Free' },
      },
    ],
  } as unknown as RegistryEntry;

  assert.deepEqual(getCardanoPricingOptions(agent), [
    {
      pricing: { pricingType: 'Dynamic' },
      supportedPaymentSourceIndex: 1,
      address: 'addr_test1_dynamic',
    },
    {
      pricing: { pricingType: 'Free' },
      supportedPaymentSourceIndex: 2,
      address: 'addr_test1_free',
    },
  ]);
});
