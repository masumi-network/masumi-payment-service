import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getOperationalPaymentSource,
  getPreferredPaymentSource,
  hasLegacyOnlyPaymentSources,
} from './payment-source-type';

const v1A = { paymentSourceType: 'Web3CardanoV1' as const, createdAt: '2024-01-01' };
const v1B = { paymentSourceType: 'Web3CardanoV1' as const, createdAt: '2024-06-01' };
const v2A = { paymentSourceType: 'Web3CardanoV2' as const, createdAt: '2024-03-01' };
const v2B = { paymentSourceType: 'Web3CardanoV2' as const, createdAt: '2024-07-01' };

test('getPreferredPaymentSource prefers V2 over V1', () => {
  assert.equal(getPreferredPaymentSource([v1A, v2A])?.paymentSourceType, 'Web3CardanoV2');
});

test('hasLegacyOnlyPaymentSources is true when only V1 exists', () => {
  assert.equal(hasLegacyOnlyPaymentSources([v1A]), true);
  assert.equal(hasLegacyOnlyPaymentSources([v1A, v2A]), false);
});

test('getOperationalPaymentSource keeps the newest V1 when no V2 exists', () => {
  assert.equal(getOperationalPaymentSource([v1A, v1B])?.paymentSourceType, 'Web3CardanoV1');
  assert.equal(getOperationalPaymentSource([v1B, v1A])?.createdAt, '2024-06-01');
});

test('getOperationalPaymentSource keeps V1 while V2 migration is incomplete', () => {
  assert.equal(
    getOperationalPaymentSource([v1A, v2B], { cardanoV2Ready: false })?.paymentSourceType,
    'Web3CardanoV1',
  );
});

test('getOperationalPaymentSource switches to V2 once the rail is ready', () => {
  assert.equal(
    getOperationalPaymentSource([v1A, v2B], { cardanoV2Ready: true })?.paymentSourceType,
    'Web3CardanoV2',
  );
  assert.equal(
    getOperationalPaymentSource([v1A, v2B], { cardanoV2Ready: true })?.createdAt,
    '2024-07-01',
  );
});
