import assert from 'node:assert/strict';
import test from 'node:test';
import type { X402Network, X402Wallet } from '@/lib/api/generated';
import {
  filterX402PaymentSourceChains,
  hasBudgetOnEnabledNetworks,
  isX402ChainUsable,
  isX402SetUpForEnv,
  resolveX402ChainEnvironment,
  walletsForNetworks,
} from './x402-rail';

function network(overrides: Partial<X402Network> = {}): X402Network {
  return {
    id: 'network-1',
    caip2Id: 'eip155:8453',
    displayName: 'Base',
    rpcUrl: 'https://mainnet.base.org',
    isTestnet: false,
    isEnabled: true,
    defaultAsset: null,
    defaultAssetDecimals: null,
    facilitatorWalletId: null,
    facilitatorWalletAddress: null,
    facilitatorUrl: null,
    createdById: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

test('remote facilitator makes an enabled chain usable without a managed wallet', () => {
  const remote = network({ facilitatorUrl: 'https://facilitator.example' });

  assert.equal(isX402ChainUsable(remote), true);
  assert.equal(isX402SetUpForEnv([remote], 'Mainnet'), true);
});

test('chain remains unusable without either facilitator mode', () => {
  assert.equal(isX402ChainUsable(network()), false);
});

test('payment sources keeps draft chains visible for management', () => {
  const ready = network({ facilitatorUrl: 'https://facilitator.example' });
  const draft = network({
    id: 'draft-network',
    caip2Id: 'eip155:84532',
    displayName: 'Base Sepolia',
    isEnabled: false,
  });

  assert.deepEqual(filterX402PaymentSourceChains([ready, draft], ''), [ready, draft]);
  assert.deepEqual(filterX402PaymentSourceChains([ready, draft], 'sepolia'), [draft]);
});

test('wallets are scoped by their structural network binding', () => {
  const mainnet = network({ id: 'mainnet-network' });
  const testnet = network({
    id: 'testnet-network',
    caip2Id: 'eip155:84532',
    isTestnet: true,
  });
  const wallets = [
    {
      id: 'mainnet-wallet',
      networkId: mainnet.id,
      caip2Network: mainnet.caip2Id,
      type: 'Purchasing',
    },
    {
      id: 'testnet-wallet',
      networkId: testnet.id,
      caip2Network: testnet.caip2Id,
      type: 'Selling',
    },
  ] as X402Wallet[];

  assert.deepEqual(
    walletsForNetworks(wallets, [mainnet]).map((wallet) => wallet.id),
    ['mainnet-wallet'],
  );
});

test('budget readiness ignores disabled networks', () => {
  const enabledNetwork = network();
  const disabledNetwork = network({
    id: 'disabled-network',
    caip2Id: 'eip155:84532',
    isEnabled: false,
  });

  assert.equal(
    hasBudgetOnEnabledNetworks(
      [{ caip2Network: disabledNetwork.caip2Id }],
      [enabledNetwork, disabledNetwork],
    ),
    false,
  );
  assert.equal(
    hasBudgetOnEnabledNetworks([{ caip2Network: enabledNetwork.caip2Id }], [enabledNetwork]),
    true,
  );
});

test('setup locks a chain to the active environment', () => {
  assert.equal(resolveX402ChainEnvironment('Preprod', false, true), true);
  assert.equal(resolveX402ChainEnvironment('Mainnet', true, true), false);
  assert.equal(resolveX402ChainEnvironment('Preprod', false, false), false);
});
