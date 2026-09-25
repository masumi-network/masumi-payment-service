import assert from 'node:assert/strict';
import test from 'node:test';
import { PREPROD_USDM_CONFIG, USDM_CONFIG, USDCX_CONFIG } from '../../lib/constants/defaultWallets';
import { hydraAssetDecimals, parseHydraAssetAmount } from './asset-amount';

for (const [label, unit] of [
  ['ADA', ''],
  ['USDM', USDM_CONFIG.fullAssetId],
  ['tUSDM', PREPROD_USDM_CONFIG.fullAssetId],
  ['USDCx', USDCX_CONFIG.fullAssetId],
]) {
  test(`${label}: normal amounts become exact base units`, () => {
    assert.equal(hydraAssetDecimals(unit), 6);
    assert.equal(parseHydraAssetAmount('50', unit), '50000000');
    assert.equal(parseHydraAssetAmount('1.234567', unit), '1234567');
    assert.equal(parseHydraAssetAmount('0.000001', unit), '1');
    assert.equal(parseHydraAssetAmount('9007199254740993.123456', unit), '9007199254740993123456');
    for (const invalid of ['', '0', '00', '0.000000', '-1', '1e6', '1.0000001', '1,000']) {
      assert.equal(parseHydraAssetAmount(invalid, unit), null, invalid);
    }
  });
}

test('custom assets stay in integer base units, including large values', () => {
  const unit = 'ab'.repeat(28) + '01';
  assert.equal(hydraAssetDecimals(unit), 0);
  assert.equal(parseHydraAssetAmount('50', unit), '50');
  assert.equal(parseHydraAssetAmount(' 00050 ', unit), '50');
  assert.equal(parseHydraAssetAmount('9007199254740993', unit), '9007199254740993');
  for (const invalid of ['0', '00', '000', '0.1', '1.0', '-1', '1e6']) {
    assert.equal(parseHydraAssetAmount(invalid, unit), null, invalid);
  }
});

test('recognize full asset IDs regardless of hex case, never only a policy ID', () => {
  assert.equal(parseHydraAssetAmount('50', USDM_CONFIG.fullAssetId.toUpperCase()), '50000000');
  assert.equal(hydraAssetDecimals(USDM_CONFIG.policyId), 0);
});
