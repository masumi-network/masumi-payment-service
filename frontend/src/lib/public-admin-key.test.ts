import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PUBLIC_ADMIN_KEYS, isPublicAdminKey } from './public-admin-key';

// The frontend cannot import the backend config, so it copies the values. If
// the backend values change and this copy does not, the banner never shows.
test('PUBLIC_ADMIN_KEYS matches the backend DEFAULTS', () => {
  const config = readFileSync(
    new URL('../../../packages/payment-core/src/config.ts', import.meta.url),
    'utf8',
  );
  const backendKeys = ['DEFAULT_ADMIN_KEY', 'EXAMPLE_ADMIN_KEY'].map((name) => {
    const match = new RegExp(`\\b${name}: '([^']+)'`).exec(config);
    assert.ok(match, `${name} not found in packages/payment-core/src/config.ts`);
    return match[1];
  });

  assert.deepEqual([...PUBLIC_ADMIN_KEYS].sort(), backendKeys.sort());
  for (const key of backendKeys) assert.equal(isPublicAdminKey(key), true);
});
