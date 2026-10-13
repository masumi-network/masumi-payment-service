import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGuardedAttachBody,
  EMPTY_GUARDED_ATTACH_FORM,
  parseQuorumKeys,
  type GuardedAttachForm,
} from './useGuardedWallet';

const KEY_A = 'A'.repeat(56);
const KEY_B = 'b'.repeat(56);
const form: GuardedAttachForm = {
  ...EMPTY_GUARDED_ATTACH_FORM,
  ownerAddress: ' addr_test1owner ',
  quorumKeys: `${KEY_A}\n${KEY_B}`,
  threshold: '2',
  stateTokenName: 'C'.repeat(64),
  exchainWalletId: 'wal_01M3P5ZM0EP8R4NCQWS7TBWZFZ',
};

test('reads quorum keys split by lines, commas or spaces, in lower case', () => {
  assert.deepEqual(parseQuorumKeys(` ${KEY_A},\n\n${KEY_B} `), ['a'.repeat(56), KEY_B]);
  assert.deepEqual(parseQuorumKeys('  \n '), []);
});

test('builds an attach body for an already registered wallet', () => {
  assert.deepEqual(buildGuardedAttachBody('hw-1', form, 'Preprod'), {
    body: {
      hotWalletId: 'hw-1',
      ownerAddress: 'addr_test1owner',
      quorumVkhs: ['a'.repeat(56), KEY_B],
      threshold: 2,
      stateTokenName: 'c'.repeat(64),
      governedAsset: 'lovelace',
      exchainWalletId: 'wal_01M3P5ZM0EP8R4NCQWS7TBWZFZ',
    },
  });
});

test('converts the mandate from ADA to lovelace when registering', () => {
  const result = buildGuardedAttachBody(
    'hw-1',
    {
      ...form,
      mode: 'register',
      perTxCap: '50',
      daily: '1000',
      perSeller: '200',
      perAgent: '500',
      envelope: '0.5',
      burstPerMinute: '10',
    },
    'Preprod',
  );
  assert.ok('body' in result);
  assert.equal(result.body.exchainWalletId, undefined);
  assert.deepEqual(result.body.register?.mandate, {
    perTxCap: '50000000',
    daily: '1000000000',
    perSeller: '200000000',
    perAgent: '500000000',
    envelope: '500000',
    burstPerMinute: 10,
  });
});

test('refuses a threshold above the number of quorum keys', () => {
  assert.deepEqual(buildGuardedAttachBody('hw-1', { ...form, threshold: '3' }, 'Preprod'), {
    error: 'Threshold must be between 1 and 2',
  });
});

test('refuses a mandate with a missing limit', () => {
  const result = buildGuardedAttachBody(
    'hw-1',
    { ...form, mode: 'register', burstPerMinute: '1' },
    'Preprod',
  );
  assert.deepEqual(result, { error: 'Every mandate limit must be a positive ADA amount' });
});

const TUSDM_ID = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde.0014df10745553444d';

test('registers a token wallet with its mandate in token minor units', () => {
  const result = buildGuardedAttachBody(
    'hw-1',
    {
      ...form,
      governedAsset: TUSDM_ID,
      mode: 'register',
      perTxCap: '5',
      daily: '100',
      perSeller: '50',
      perAgent: '50',
      envelope: '1000',
      burstPerMinute: '10',
    },
    'Preprod',
  );
  assert.ok('body' in result);
  assert.equal(result.body.governedAsset, TUSDM_ID);
  assert.equal(result.body.register?.mandate.daily, '100000000');
});

test('refuses to reuse an Exchain wallet id for a token wallet', () => {
  assert.deepEqual(
    buildGuardedAttachBody('hw-1', { ...form, governedAsset: TUSDM_ID }, 'Preprod'),
    {
      error: 'A wallet that pays in a token must be registered here',
    },
  );
});

test('names the payment asset when a mandate limit is missing', () => {
  const result = buildGuardedAttachBody(
    'hw-1',
    { ...form, governedAsset: TUSDM_ID, mode: 'register', burstPerMinute: '1' },
    'Preprod',
  );
  assert.deepEqual(result, { error: 'Every mandate limit must be a positive tUSDM amount' });
});
