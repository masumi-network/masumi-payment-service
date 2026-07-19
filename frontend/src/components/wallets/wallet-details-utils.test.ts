import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRuleTopupInput } from './wallet-details-utils';

test('allows a new rule to leave auto top-up disabled without an amount', () => {
  assert.deepEqual(
    validateRuleTopupInput({
      enabled: false,
      topupAmountInput: '',
      assetUnit: 'lovelace',
      network: 'Preprod',
    }),
    {
      rawTopupAmount: null,
      error: null,
    },
  );
});

test('converts a valid ADA auto top-up amount before rule creation', () => {
  assert.deepEqual(
    validateRuleTopupInput({
      enabled: true,
      topupAmountInput: '12.5',
      assetUnit: 'lovelace',
      network: 'Preprod',
    }),
    {
      rawTopupAmount: '12500000',
      error: null,
    },
  );
});

test('rejects ADA auto top-up amounts below the transaction floor', () => {
  assert.deepEqual(
    validateRuleTopupInput({
      enabled: true,
      topupAmountInput: '4.999999',
      assetUnit: 'lovelace',
      network: 'Preprod',
    }),
    {
      rawTopupAmount: '4999999',
      error: 'ADA top-up amount must be at least 5 ADA.',
    },
  );
});

test('rejects auto top-up for an invalid custom asset unit', () => {
  assert.deepEqual(
    validateRuleTopupInput({
      enabled: true,
      topupAmountInput: '10',
      assetUnit: 'not-a-cardano-asset',
      network: 'Preprod',
    }),
    {
      rawTopupAmount: '10',
      error:
        'Auto top-up needs a valid Cardano asset unit: policy id followed by an asset name of at most 32 bytes.',
    },
  );
});
