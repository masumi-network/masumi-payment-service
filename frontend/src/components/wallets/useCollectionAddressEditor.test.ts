import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeCollectionAddressUsage,
  normalizeCollectionAddress,
  resolveCollectionAddress,
} from './useCollectionAddressEditor';

test('normalizes a collection-address draft before saving', () => {
  assert.equal(normalizeCollectionAddress('  addr_test1example  '), 'addr_test1example');
  assert.equal(normalizeCollectionAddress('   '), null);
});

test('uses the wallet value before an editor save', () => {
  assert.equal(resolveCollectionAddress(undefined, 'addr_test1wallet'), 'addr_test1wallet');
  assert.equal(resolveCollectionAddress(undefined, undefined), null);
});

test('keeps a local clear instead of falling back to the stale wallet value', () => {
  assert.equal(resolveCollectionAddress(null, 'addr_test1wallet'), null);
  assert.equal(resolveCollectionAddress('addr_test1saved', 'addr_test1wallet'), 'addr_test1saved');
});

test('a failed usage lookup never reads as an unused address', () => {
  assert.equal(
    describeCollectionAddressUsage(0),
    'Collection address has not been used yet, please check if this is the correct address',
  );
  assert.equal(describeCollectionAddressUsage(3), null);
  assert.equal(
    describeCollectionAddressUsage(null),
    'Could not check this collection address on chain, please verify it yourself',
  );
});
