import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMainNavigation } from './main-navigation';

const baseOptions = {
  activeRail: 'x402' as const,
  canAdmin: false,
  canPay: false,
  canShowHydraNav: false,
  hasPaymentSources: false,
  isSetupMode: false,
  isX402Standalone: true,
  setupHref: '/x402-setup' as const,
  transactionBadge: null,
  walletAlertCount: 0,
};

test('x402 admin navigation follows the Cardano information order', () => {
  const items = buildMainNavigation({ ...baseOptions, canAdmin: true, canPay: true });

  assert.deepEqual(
    items.map(({ name, href }) => [name, href]),
    [
      ['Dashboard', '/x402/dashboard'],
      ['AI Agents', '/ai-agents'],
      ['Wallets', '/x402/wallets'],
      ['Transactions', '/x402/payments'],
      ['Webhooks', '/webhooks'],
      ['API keys', '/api-keys'],
      ['Developers', '/developers'],
    ],
  );
});

test('x402 pay navigation omits administrator-only API keys', () => {
  const names = buildMainNavigation({ ...baseOptions, canPay: true }).map((item) => item.name);

  assert.deepEqual(names, [
    'Dashboard',
    'AI Agents',
    'Wallets',
    'Transactions',
    'Webhooks',
    'Developers',
  ]);
});

test('x402 read navigation omits pay and administrator actions', () => {
  const names = buildMainNavigation(baseOptions).map((item) => item.name);

  assert.deepEqual(names, ['Dashboard', 'AI Agents', 'Wallets', 'Transactions', 'Developers']);
});

test('x402 setup uses the focused x402 setup link', () => {
  const items = buildMainNavigation({
    ...baseOptions,
    canAdmin: true,
    canPay: true,
    isSetupMode: true,
  });

  assert.equal(items[0].name, 'Setup');
  assert.equal(items[0].href, '/x402-setup');
});
