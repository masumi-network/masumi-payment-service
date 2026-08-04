import assert from 'node:assert/strict';
import test from 'node:test';
import type { X402AvailableNetwork, X402Wallet } from '@/lib/api/generated';
import {
  assetPresetsForNetwork,
  defaultX402Option,
  findX402ValidationError,
  normalizeX402Amount,
  validateX402Options,
  x402AmountFromBaseUnits,
  type X402OptionDraft,
} from './x402-registration';

function network(overrides: Partial<X402AvailableNetwork> = {}): X402AvailableNetwork {
  return {
    id: 'base',
    caip2Id: 'eip155:8453',
    displayName: 'Base',
    isTestnet: false,
    isEnabled: true,
    canSettle: true,
    defaultAsset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    defaultAssetDecimals: 6,
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

test('blank decimals are rejected for a custom token instead of coercing to 0', () => {
  assert.equal(
    validateX402Options([
      option({ asset: '0x9999999999999999999999999999999999999999', decimals: '' }),
    ]),
    'x402 option 1: decimals must be a whole number between 0 and 255',
  );
  assert.equal(
    validateX402Options([
      option({
        pricingType: 'Dynamic',
        asset: '0x9999999999999999999999999999999999999999',
        amount: '',
        decimals: '',
      }),
    ]),
    'x402 option 1: decimals must be a whole number between 0 and 255',
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

test('resource URLs must parse and respect the backend length cap', () => {
  // Scheme-only strings pass a bare regex but are not real URLs.
  assert.equal(
    validateX402Options([option({ resource: 'https://' })]),
    'x402 option 1: resource must be an http(s) URL',
  );
  assert.equal(
    validateX402Options([option({ resource: 'ftp://example.com/resource' })]),
    'x402 option 1: resource must be an http(s) URL',
  );
  assert.equal(
    validateX402Options([option({ resource: `https://example.com/${'a'.repeat(500)}` })]),
    'x402 option 1: resource URL must be at most 500 characters',
  );
  assert.equal(validateX402Options([option({ resource: 'https://example.com/resource' })]), null);
});

test('labels align error messages with the dialog-wide payment-option numbering', () => {
  assert.deepEqual(findX402ValidationError([option({ caip2Network: '' })], ['Payment option 2']), {
    index: 0,
    message: 'Payment option 2: select a chain',
  });

  const duplicate = option({ id: 'duplicate' });
  assert.deepEqual(
    findX402ValidationError([option(), duplicate], ['Payment option 1', 'Payment option 3']),
    {
      index: 1,
      message:
        'Payment option 3: duplicates Payment option 1. ' +
        'Change its chain, pricing, coin, recipient, or resource.',
    },
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
