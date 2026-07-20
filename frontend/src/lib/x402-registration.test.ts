import assert from 'node:assert/strict';
import test from 'node:test';
import type { X402Network, X402Wallet } from '@/lib/api/generated';
import {
  assetPresetsForNetwork,
  defaultX402Option,
  findX402ValidationError,
  normalizeX402Amount,
  validateX402Options,
  x402AmountFromBaseUnits,
  type X402OptionDraft,
} from './x402-registration';

function network(overrides: Partial<X402Network> = {}): X402Network {
  return {
    id: 'base',
    caip2Id: 'eip155:8453',
    displayName: 'Base',
    rpcUrl: 'https://mainnet.base.org',
    isTestnet: false,
    isEnabled: true,
    defaultAsset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    defaultAssetDecimals: 6,
    facilitatorWalletId: null,
    facilitatorWalletAddress: null,
    facilitatorUrl: null,
    createdById: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function option(overrides: Partial<X402OptionDraft> = {}): X402OptionDraft {
  return {
    id: 'option',
    pricingType: 'Fixed',
    caip2Network: 'eip155:8453',
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    amount: '1.25',
    decimals: '6',
    payTo: '0x1111111111111111111111111111111111111111',
    resource: '',
    ...overrides,
  };
}

test('x402 amounts round-trip between display and atomic units', () => {
  assert.equal(normalizeX402Amount('1.25', '6'), '1250000');
  assert.equal(x402AmountFromBaseUnits('1250000', 6), '1.25');
});

test('x402 validation rejects precision beyond the selected token', () => {
  assert.equal(
    validateX402Options([option({ amount: '1.0000001' })]),
    'x402 option 1: amount supports at most 6 decimal places',
  );
});

test('x402 validation rejects fixed amounts outside the database range', () => {
  assert.equal(
    validateX402Options([option({ amount: '9223372036855', decimals: '6' })]),
    'x402 option 1: enter an amount between 1 and 9223372036854775807 atomic units',
  );
});

test('new Base option defaults to asset-agnostic dynamic pricing and a managed selling wallet', () => {
  const base = network();
  const wallet = {
    id: 'selling-wallet',
    networkId: base.id,
    caip2Network: base.caip2Id,
    address: '0x2222222222222222222222222222222222222222',
    type: 'Selling',
  } as X402Wallet;

  const draft = defaultX402Option([base], [wallet], base.id);

  assert.equal(draft.pricingType, 'Dynamic');
  assert.equal(draft.asset, '');
  assert.equal(draft.decimals, '');
  assert.equal(draft.payTo, wallet.address);
});

test('dynamic pricing accepts either any runtime asset or an ERC-20 allowlist', () => {
  assert.equal(
    validateX402Options([option({ pricingType: 'Dynamic', asset: '', amount: '', decimals: '' })]),
    null,
  );
  assert.equal(
    validateX402Options([option({ pricingType: 'Dynamic', amount: '', decimals: '6' })]),
    null,
  );
  assert.equal(
    validateX402Options([
      option({ pricingType: 'Dynamic', asset: 'native', amount: '', decimals: '18' }),
    ]),
    'x402 option 1: select a coin or enter a token contract',
  );
});

test('free pricing does not require an asset or amount', () => {
  assert.equal(
    validateX402Options([option({ pricingType: 'Free', asset: '', amount: '', decimals: '' })]),
    null,
  );
});

test('configured default tokens use their persisted decimals without guessing', () => {
  const customAsset = '0x9999999999999999999999999999999999999999';
  assert.deepEqual(
    assetPresetsForNetwork(
      network({
        caip2Id: 'eip155:999999',
        displayName: 'Custom EVM',
        defaultAsset: customAsset,
        defaultAssetDecimals: 8,
      }),
    )[0],
    {
      network: 'eip155:999999',
      symbol: 'Default token',
      name: 'Custom EVM default token',
      address: customAsset,
      decimals: 8,
    },
  );
  assert.deepEqual(
    assetPresetsForNetwork(
      network({
        caip2Id: 'eip155:999999',
        defaultAsset: customAsset,
        defaultAssetDecimals: null,
      }),
    ),
    [],
  );
  assert.equal(
    assetPresetsForNetwork(network({ defaultAssetDecimals: 8 }))[0]?.decimals,
    8,
    'the configured network value is authoritative even for a known preset address',
  );
});

test('duplicate x402 options identify the exact offending row case-insensitively', () => {
  const duplicate = option({
    id: 'duplicate',
    asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    payTo: '0x1111111111111111111111111111111111111111',
  });

  assert.deepEqual(findX402ValidationError([option(), duplicate]), {
    index: 1,
    message:
      'x402 option 2: duplicates option 1. Change its chain, pricing, coin, recipient, or resource.',
  });
});

test('duplicate x402 options canonicalize equivalent decimal spellings', () => {
  const duplicate = option({
    id: 'duplicate',
    decimals: '06',
  });

  assert.deepEqual(findX402ValidationError([option(), duplicate]), {
    index: 1,
    message:
      'x402 option 2: duplicates option 1. Change its chain, pricing, coin, recipient, or resource.',
  });
});
