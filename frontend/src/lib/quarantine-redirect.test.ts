import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildQuarantineRedirectTarget,
  QUARANTINE_CANONICAL_PATH,
  QUARANTINE_LEGACY_PATH,
} from './quarantine-redirect.js';

test('buildQuarantineRedirectTarget points at the canonical quarantine page', () => {
  assert.equal(buildQuarantineRedirectTarget().pathname, QUARANTINE_CANONICAL_PATH);
});

test('buildQuarantineRedirectTarget preserves query parameters', () => {
  assert.deepEqual(buildQuarantineRedirectTarget({ network: 'Preprod', page: '2' }), {
    pathname: QUARANTINE_CANONICAL_PATH,
    query: { network: 'Preprod', page: '2' },
  });
});

test('legacy and canonical paths differ', () => {
  assert.notEqual(QUARANTINE_LEGACY_PATH, QUARANTINE_CANONICAL_PATH);
});
