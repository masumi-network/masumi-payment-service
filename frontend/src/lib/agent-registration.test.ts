import assert from 'node:assert/strict';
import test from 'node:test';
import type { RegistryEntry } from '@/lib/api/generated';
import {
  buildMasumiSupportedSources,
  buildOrderedSupportedPaymentSources,
  buildPaymentOptionPrefill,
  MASUMI_PAYMENT_OPTION_ID,
  validateMasumiOptions,
  type CardanoSupportedSource,
  type EvmSupportedSource,
  type MasumiOptionDraft,
} from './agent-registration';
import type { X402OptionDraft } from './x402-registration';

const STABLECOIN_ASSET = 'policyid0000tUSDM';

function masumiOption(overrides: Partial<MasumiOptionDraft> = {}): MasumiOptionDraft {
  return {
    id: 'masumi-1',
    pricingType: 'Fixed',
    prices: [{ unit: 'lovelace', amount: '1' }],
    ...overrides,
  };
}

function x402Option(overrides: Partial<X402OptionDraft> = {}): X402OptionDraft {
  return {
    id: 'x402-1',
    pricingType: 'Dynamic',
    caip2Network: 'eip155:8453',
    asset: '',
    amount: '',
    decimals: '',
    payTo: '0x1111111111111111111111111111111111111111',
    resource: '',
    ...overrides,
  };
}

function cardanoSource(overrides: Partial<CardanoSupportedSource> = {}): CardanoSupportedSource {
  return {
    chain: 'Cardano',
    network: 'Preprod',
    paymentSourceType: 'Web3CardanoV2',
    address: 'addr_test1_a',
    pricing: { pricingType: 'Dynamic' },
    ...overrides,
  } as CardanoSupportedSource;
}

function evmSource(overrides: Partial<EvmSupportedSource> = {}): EvmSupportedSource {
  return {
    chain: 'EVM',
    network: 'eip155:8453',
    scheme: 'Exact',
    payTo: '0x1111111111111111111111111111111111111111',
    resource: undefined,
    pricing: { pricingType: 'Dynamic' },
    ...overrides,
  } as EvmSupportedSource;
}

test('prefill keeps each stored source address, index, and the stored row order', () => {
  const prefill = buildPaymentOptionPrefill({
    supportedPaymentSources: [
      {
        chain: 'EVM',
        network: 'eip155:8453',
        scheme: 'Exact',
        payTo: '0x1111111111111111111111111111111111111111',
        pricing: { pricingType: 'Dynamic' },
      },
      {
        chain: 'Cardano',
        network: 'Preprod',
        paymentSourceType: 'Web3CardanoV2',
        address: 'addr_test1_old_contract',
        pricing: {
          pricingType: 'Fixed',
          fixed: [{ asset: '', amount: '1000000' }],
        },
      },
      {
        chain: 'Cardano',
        network: 'Preprod',
        paymentSourceType: 'Web3CardanoV2',
        address: 'addr_test1_other_contract',
        pricing: { pricingType: 'Free' },
      },
    ] as RegistryEntry['supportedPaymentSources'],
    legacyPricing: { pricingType: 'Free' },
    stablecoinUnit: 'tUSDM',
    stablecoinFullAssetId: STABLECOIN_ASSET,
  });

  // Rows interleave in the STORED order so payment-option numbers match
  // on-chain indexes: [x402, Masumi, Masumi].
  assert.deepEqual(
    prefill.paymentOptionRows.map((row) => row.type),
    ['x402', 'Masumi', 'Masumi'],
  );
  assert.deepEqual(
    prefill.masumiOptions.map((option) => ({
      address: option.address,
      originalIndex: option.originalIndex,
    })),
    [
      { address: 'addr_test1_old_contract', originalIndex: 1 },
      { address: 'addr_test1_other_contract', originalIndex: 2 },
    ],
  );
  assert.equal(prefill.x402Options[0]?.originalIndex, 0);
  // Stored base units map back to decimal display values.
  assert.deepEqual(prefill.masumiOptions[0]?.prices, [{ unit: 'lovelace', amount: '1' }]);
});

test('prefill falls back to a single legacy Masumi option without stored sources', () => {
  const prefill = buildPaymentOptionPrefill({
    supportedPaymentSources: null,
    legacyPricing: { pricingType: 'Fixed', Pricing: [{ unit: 'lovelace', amount: '2500000' }] },
    stablecoinUnit: 'tUSDM',
    stablecoinFullAssetId: STABLECOIN_ASSET,
  });

  assert.deepEqual(prefill.paymentOptionRows, [{ id: MASUMI_PAYMENT_OPTION_ID, type: 'Masumi' }]);
  assert.deepEqual(prefill.masumiOptions, [
    {
      id: MASUMI_PAYMENT_OPTION_ID,
      pricingType: 'Fixed',
      prices: [{ unit: 'lovelace', amount: '2.5' }],
    },
  ]);
  assert.equal(prefill.masumiOptions[0]?.address, undefined);
});

test('rebuilt Masumi sources keep their stored address; only new options use the fallback', () => {
  const options = [
    masumiOption({ id: 'stored', address: 'addr_test1_old_contract', originalIndex: 0 }),
    masumiOption({ id: 'added', pricingType: 'Free', prices: [] }),
  ];
  const pricingByOptionId = new Map<string, CardanoSupportedSource['pricing']>([
    ['stored', { pricingType: 'Fixed', fixed: [{ asset: '', amount: '1000000' }] }],
    ['added', { pricingType: 'Free' }],
  ]);

  const sources = buildMasumiSupportedSources({
    masumiOptions: options,
    pricingByOptionId,
    network: 'Preprod',
    fallbackAddress: 'addr_test1_editing_source',
  });

  assert.deepEqual(
    sources.map((source) => source.address),
    ['addr_test1_old_contract', 'addr_test1_editing_source'],
  );
});

test('submitted sources preserve stored order for survivors and append new options', () => {
  // Stored order: [EVM(0), Cardano(1)]. Dialog rows show the same order plus
  // a newly added Masumi option and a newly added x402 option at the end.
  const survivingMasumi = masumiOption({ id: 'm-stored', originalIndex: 1 });
  const addedMasumi = masumiOption({ id: 'm-new' });
  const survivingX402 = x402Option({ id: 'x-stored', originalIndex: 0 });
  const addedX402 = x402Option({ id: 'x-new' });

  const orderedSources = buildOrderedSupportedPaymentSources({
    masumiOptions: [survivingMasumi, addedMasumi],
    masumiSources: [
      cardanoSource({ address: 'addr_stored' }),
      cardanoSource({ address: 'addr_new' }),
    ],
    x402Options: [survivingX402, addedX402],
    evmSources: [
      evmSource({ payTo: '0x1111111111111111111111111111111111111111' }),
      evmSource({ payTo: '0x2222222222222222222222222222222222222222' }),
    ],
    // Dialog row order: stored x402, stored Masumi, new Masumi, new x402.
    rowIndexById: new Map([
      ['x-stored', 0],
      ['m-stored', 1],
      ['m-new', 2],
      ['x-new', 3],
    ]),
  });

  assert.deepEqual(
    orderedSources.map((source) => (source.chain === 'Cardano' ? source.address : source.payTo)),
    [
      // Survivors first, in stored on-chain order (EVM 0, Cardano 1)...
      '0x1111111111111111111111111111111111111111',
      'addr_stored',
      // ...then new options appended in dialog row order.
      'addr_new',
      '0x2222222222222222222222222222222222222222',
    ],
  );
});

test('fresh registrations submit sources in dialog row order', () => {
  const orderedSources = buildOrderedSupportedPaymentSources({
    masumiOptions: [masumiOption({ id: 'm-1' })],
    masumiSources: [cardanoSource({ address: 'addr_active' })],
    x402Options: [x402Option({ id: 'x-1' })],
    evmSources: [evmSource()],
    rowIndexById: new Map([
      ['x-1', 0],
      ['m-1', 1],
    ]),
  });

  assert.deepEqual(
    orderedSources.map((source) => source.chain),
    ['EVM', 'Cardano'],
  );
});

test('masumi validation numbers errors with the dialog-wide option numbers', () => {
  const result = validateMasumiOptions({
    masumiOptions: [masumiOption({ id: 'm-1', prices: [{ unit: 'lovelace', amount: '0' }] })],
    // The Masumi row is payment option 3 in the dialog (after two x402 rows).
    optionNumberById: new Map([['m-1', 3]]),
    stablecoinUnit: 'tUSDM',
    stablecoinAsset: STABLECOIN_ASSET,
  });

  assert.ok('error' in result);
  assert.equal(
    result.error.message,
    'Masumi option 3: each price must be greater than zero and fit in the supported range',
  );
  assert.equal(result.error.optionId, 'm-1');
});

test('duplicate detection folds lovelace aliases and asset casing like the backend', () => {
  // A raw legacy unit 'LOVELACE' (kept verbatim by the prefill mapping) must
  // collide with the explicit 'lovelace' option: the backend canonicalizes
  // both to '' before checking duplicates.
  const result = validateMasumiOptions({
    masumiOptions: [
      masumiOption({ id: 'm-1', prices: [{ unit: 'lovelace', amount: '1' }] }),
      masumiOption({
        id: 'm-2',
        prices: [{ unit: 'LOVELACE' as 'lovelace', amount: '1' }],
      }),
    ],
    optionNumberById: new Map([
      ['m-1', 1],
      ['m-2', 2],
    ]),
    stablecoinUnit: 'tUSDM',
    stablecoinAsset: STABLECOIN_ASSET,
  });

  assert.ok('error' in result);
  assert.equal(
    result.error.message,
    'Masumi option 2: duplicates payment option 1. ' +
      'Choose a different pricing model, coin, or amount.',
  );
});

test('valid masumi options produce source-owned pricing in base units', () => {
  const result = validateMasumiOptions({
    masumiOptions: [
      masumiOption({
        id: 'm-1',
        prices: [
          { unit: 'lovelace', amount: '1.5' },
          { unit: 'tUSDM', amount: '2' },
        ],
      }),
    ],
    optionNumberById: new Map([['m-1', 1]]),
    stablecoinUnit: 'tUSDM',
    stablecoinAsset: STABLECOIN_ASSET,
  });

  assert.ok('pricingByOptionId' in result);
  assert.deepEqual(result.pricingByOptionId.get('m-1'), {
    pricingType: 'Fixed',
    fixed: [
      { asset: '', amount: '1500000' },
      { asset: STABLECOIN_ASSET, amount: '2000000' },
    ],
  });
});
