import assert from 'node:assert/strict';
import test from 'node:test';
import { fundingLovelaceToAda, parseAutomaticFundingLimit } from './automatic-funding';

test('funding limits retain every lovelace through an unchanged ADA form', () => {
  for (const amount of [
    '0',
    '1',
    '1000000',
    '30000001',
    '9007199254740993',
    '9223372036854775807',
  ]) {
    assert.equal(parseAutomaticFundingLimit(fundingLovelaceToAda(amount)), amount);
  }
});

test('funding limits accept exact ADA values including zero', () => {
  assert.equal(parseAutomaticFundingLimit('0.000000'), '0');
  assert.equal(parseAutomaticFundingLimit(' 00030.000001 '), '30000001');
});

test('funding limits reject negative, imprecise, malformed and overflowing amounts', () => {
  for (const amount of ['', '-1', '0.0000001', '1e2', '1.', 'NaN', '9223372036854.775808']) {
    assert.equal(parseAutomaticFundingLimit(amount), null, amount);
  }
});
