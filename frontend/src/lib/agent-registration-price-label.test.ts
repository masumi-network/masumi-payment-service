import assert from 'node:assert/strict';
import test from 'node:test';
import { getPriceAmountAriaLabel, getPriceAmountLabel } from './agent-registration-price-label';

test('getPriceAmountLabel includes the display unit for ADA rows', () => {
  assert.equal(getPriceAmountLabel('ADA'), 'Amount (ADA)');
});

test('getPriceAmountLabel includes the display unit for stablecoin rows', () => {
  assert.equal(getPriceAmountLabel('tUSDM'), 'Amount (tUSDM)');
  assert.equal(getPriceAmountLabel('USDCx'), 'Amount (USDCx)');
});

test('getPriceAmountAriaLabel announces the unit to assistive technology', () => {
  assert.equal(getPriceAmountAriaLabel('ADA', 0), 'Amount in ADA for Masumi price 1');
  assert.equal(getPriceAmountAriaLabel('USDCx', 2), 'Amount in USDCx for Masumi price 3');
});
