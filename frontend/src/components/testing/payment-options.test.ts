import assert from 'node:assert/strict';
import test from 'node:test';
import type { RegistryEntry } from '@/lib/api/generated';
import { buildPaidAgentOptions } from './payment-options';

function agent(overrides: Partial<RegistryEntry>): RegistryEntry {
  return {
    id: 'agent-1',
    name: 'Agent One',
    state: 'RegistrationConfirmed',
    agentIdentifier: 'a'.repeat(57),
    AgentPricing: null,
    supportedPaymentSources: null,
    ...overrides,
  } as RegistryEntry;
}

test('includes UpdateConfirmed agents as registered payment options', () => {
  const options = buildPaidAgentOptions(
    [
      agent({
        state: 'UpdateConfirmed',
        AgentPricing: { pricingType: 'Fixed', Pricing: [{ unit: '', amount: '500000' }] },
      }),
    ],
    'Web3CardanoV1',
  );

  assert.equal(options.length, 1);
  assert.equal(options[0]?.paymentSourceType, 'Web3CardanoV1');
  assert.equal(options[0]?.supportedPaymentSourceIndex, undefined);
});

test('includes every paid V2 Cardano option and preserves metadata indexes', () => {
  const options = buildPaidAgentOptions(
    [
      agent({
        supportedPaymentSources: [
          {
            chain: 'Cardano',
            network: 'Preprod',
            paymentSourceType: 'Web3CardanoV2',
            address: 'addr_test1_free',
            pricing: { pricingType: 'Free' },
          },
          {
            chain: 'EVM',
            network: 'eip155:84532',
            scheme: 'Exact',
            payTo: '0x0000000000000000000000000000000000000001',
            pricing: { pricingType: 'Dynamic' },
          },
          {
            chain: 'Cardano',
            network: 'Preprod',
            paymentSourceType: 'Web3CardanoV2',
            address: 'addr_test1_dynamic',
            pricing: { pricingType: 'Dynamic' },
          },
          {
            chain: 'Cardano',
            network: 'Preprod',
            paymentSourceType: 'Web3CardanoV2',
            address: 'addr_test1_fixed',
            pricing: {
              pricingType: 'Fixed',
              fixed: [{ asset: '', amount: '750000' }],
            },
          },
        ],
      }),
    ],
    'Web3CardanoV2',
  );

  assert.deepEqual(
    options.map((option) => ({
      index: option.supportedPaymentSourceIndex,
      pricingType: option.pricingType,
    })),
    [
      { index: 2, pricingType: 'Dynamic' },
      { index: 3, pricingType: 'Fixed' },
    ],
  );
  // Labels number by the overall metadata index (position within
  // supportedPaymentSources), matching the registration dialog's numbering,
  // not by position within the paid-Cardano subset.
  assert.deepEqual(
    options.map((option) => option.label),
    ['Agent One · Masumi option 3', 'Agent One · Masumi option 4'],
  );
});

test('does not expose free-only or unconfirmed agents in the payment cycle', () => {
  const options = buildPaidAgentOptions(
    [
      agent({ AgentPricing: { pricingType: 'Free' } }),
      agent({
        id: 'agent-2',
        state: 'RegistrationInitiated',
        AgentPricing: { pricingType: 'Dynamic' },
      }),
    ],
    'Web3CardanoV1',
  );

  assert.deepEqual(options, []);
});
