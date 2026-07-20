import assert from 'node:assert/strict';
import test from 'node:test';
import type { RegistryEntry } from '@/lib/api/generated';
import {
  getCardanoPricingOptions,
  getPrimaryCardanoPricing,
  parseLegacyAgentPricing,
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
