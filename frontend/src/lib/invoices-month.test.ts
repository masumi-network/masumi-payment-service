import assert from 'node:assert/strict';
import test from 'node:test';

import { getCurrentMonth } from './invoices-month.js';

test('getCurrentMonth returns the current calendar month', () => {
  assert.equal(getCurrentMonth(new Date(2026, 7, 15)), '2026-08');
});

test('getCurrentMonth keeps January in the current year', () => {
  assert.equal(getCurrentMonth(new Date(2026, 0, 10)), '2026-01');
});

test('getCurrentMonth pads single-digit months', () => {
  assert.equal(getCurrentMonth(new Date(2026, 2, 1)), '2026-03');
});
