import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compatibilityX402Target,
  deniedPathFallback,
  isX402RailPath,
  legacyX402Target,
  railHomePath,
  setupPath,
  shouldRestoreX402Rail,
} from './x402-navigation';

test('legacy x402 tabs map to their stable route and preserve unrelated query fields', () => {
  assert.deepEqual(legacyX402Target({ tab: 'Payments', network: 'Preprod', cursor: 'next' }), {
    pathname: '/x402/payments',
    query: { network: 'Preprod', cursor: 'next' },
  });
  assert.deepEqual(legacyX402Target({ tab: 'Chains', network: 'Preprod' }), {
    pathname: '/payment-sources',
    query: { network: 'Preprod' },
  });
});

test('legacy wallet policy tabs now open wallets', () => {
  assert.equal(legacyX402Target({ tab: 'Budgets' }).pathname, '/x402/wallets');
  assert.equal(legacyX402Target({ tab: 'Alerts' }).pathname, '/x402/wallets');
});

test('x402 without a recognized tab opens the dashboard', () => {
  assert.equal(legacyX402Target({}).pathname, '/x402/dashboard');
  assert.equal(legacyX402Target({ tab: 'old-tab' }).pathname, '/x402/dashboard');
});

test('compatibility routes preserve their query', () => {
  assert.deepEqual(compatibilityX402Target('/x402/chains', { network: 'Mainnet' }), {
    pathname: '/payment-sources',
    query: { network: 'Mainnet' },
  });
  assert.equal(compatibilityX402Target('/x402/budgets', {}).pathname, '/x402/wallets');
  assert.equal(compatibilityX402Target('/x402/alerts', {}).pathname, '/x402/wallets');
});

test('direct x402 routes restore the rail only after available chains load', () => {
  assert.equal(shouldRestoreX402Rail('/x402/dashboard', true, 1), false);
  assert.equal(shouldRestoreX402Rail('/x402/dashboard', false, 0), false);
  assert.equal(shouldRestoreX402Rail('/x402/dashboard', false, 1), true);
  assert.equal(shouldRestoreX402Rail('/x402/dashboard', false, 1, true), false);
  assert.equal(shouldRestoreX402Rail('/wallets', false, 1), false);
});

test('x402 permission fallback, home, and setup paths keep rail context', () => {
  assert.equal(isX402RailPath('/x402-setup'), true);
  assert.equal(deniedPathFallback('/x402/chains', '/developers'), '/x402/dashboard');
  assert.equal(deniedPathFallback('/setup', '/developers'), '/developers');
  assert.equal(railHomePath('x402'), '/x402/dashboard');
  assert.equal(railHomePath('cardano'), '/');
  assert.equal(setupPath('cardano', '/x402-setup'), '/x402-setup');
  assert.equal(setupPath('x402', '/setup'), '/setup');
  assert.equal(setupPath('x402', '/settings'), '/x402-setup');
});
