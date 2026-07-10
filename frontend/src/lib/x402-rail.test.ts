import assert from 'node:assert/strict';
import test from 'node:test';
import type { X402Network } from '@/lib/api/generated';
import { isX402ChainUsable, isX402SetUpForEnv } from './x402-rail';

function network(overrides: Partial<X402Network> = {}): X402Network {
  return {
    id: 'network-1',
    caip2Id: 'eip155:8453',
    displayName: 'Base',
    rpcUrl: 'https://mainnet.base.org',
    isTestnet: false,
    isEnabled: true,
    defaultAsset: null,
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
