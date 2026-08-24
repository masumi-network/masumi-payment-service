import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateX402DashboardBalances, type X402DashboardBalanceRead } from './x402-dashboard';

const TOKEN_A = '0x1111111111111111111111111111111111111111';
const TOKEN_B = '0x2222222222222222222222222222222222222222';

function balanceRead(
  walletId: string,
  overrides: Partial<X402DashboardBalanceRead['balances'][number]> = {},
): X402DashboardBalanceRead {
  return {
    walletId,
    requestFailed: false,
    balances: [
      {
        caip2Network: 'eip155:8453',
        displayName: 'Base',
        native: { symbol: 'ETH', decimals: 18, amount: '0' },
        asset: { asset: TOKEN_A, symbol: 'USDC', decimals: 6, amount: '0' },
        error: null,
        ...overrides,
      },
    ],
  };
}

test('aggregates atomic amounts with BigInt beyond the safe integer range', () => {
  const result = aggregateX402DashboardBalances([
    balanceRead('wallet-1', {
      native: { symbol: 'ETH', decimals: 18, amount: '9007199254740993' },
      asset: null,
    }),
    balanceRead('wallet-2', {
      native: { symbol: 'ETH', decimals: 18, amount: '7' },
      asset: null,
    }),
  ]);

  assert.equal(result.balances[0]?.amount, '9007199254741000');
  assert.equal(result.balances[0]?.walletCount, 2);
});

test('keeps different token contracts separate even when their symbols match', () => {
  const result = aggregateX402DashboardBalances([
    balanceRead('wallet-1', {
      native: null,
      asset: { asset: TOKEN_A, symbol: 'USDC', decimals: 6, amount: '1000000' },
    }),
    balanceRead('wallet-2', {
      native: null,
      asset: { asset: TOKEN_B, symbol: 'USDC', decimals: 6, amount: '2000000' },
    }),
  ]);

  assert.deepEqual(
    result.balances.map((balance) => [balance.asset, balance.amount]),
    [
      [TOKEN_A, '1000000'],
      [TOKEN_B, '2000000'],
    ],
  );
});

test('normalizes contract address case but keeps chains separate', () => {
  const result = aggregateX402DashboardBalances([
    balanceRead('wallet-1', {
      native: null,
      asset: { asset: TOKEN_A.toUpperCase(), symbol: 'USDC', decimals: 6, amount: '3' },
    }),
    balanceRead('wallet-2', {
      native: null,
      asset: { asset: TOKEN_A, symbol: 'USDC', decimals: 6, amount: '4' },
    }),
    balanceRead('wallet-3', {
      caip2Network: 'eip155:84532',
      displayName: 'Base Sepolia',
      native: null,
      asset: { asset: TOKEN_A, symbol: 'USDC', decimals: 6, amount: '5' },
    }),
  ]);

  assert.deepEqual(
    result.balances.map((balance) => [balance.caip2Network, balance.amount]),
    [
      ['eip155:8453', '7'],
      ['eip155:84532', '5'],
    ],
  );
});

test('keeps valid balances and reports partial read failures', () => {
  const result = aggregateX402DashboardBalances([
    balanceRead('wallet-1', {
      native: { symbol: 'ETH', decimals: 18, amount: '12' },
      asset: null,
    }),
    { walletId: 'wallet-2', requestFailed: true, balances: [] },
    balanceRead('wallet-3', {
      native: null,
      asset: null,
      error: 'RPC unavailable',
    }),
  ]);

  assert.equal(result.balances[0]?.amount, '12');
  assert.equal(result.failedReadCount, 2);
});

test('rejects conflicting decimals for the same chain and asset', () => {
  const result = aggregateX402DashboardBalances([
    balanceRead('wallet-a', {
      caip2Network: 'eip155:84532',
      displayName: 'Base Sepolia',
      native: null,
      asset: {
        asset: '0xToken',
        symbol: 'USDC',
        decimals: 6,
        amount: '1000000',
      },
    }),
    balanceRead('wallet-b', {
      caip2Network: 'eip155:84532',
      displayName: 'Base Sepolia',
      native: null,
      asset: {
        asset: '0xtoken',
        symbol: 'USDC',
        decimals: 18,
        amount: '1000000000000000000',
      },
    }),
  ]);

  assert.equal(result.failedReadCount, 2);
  assert.deepEqual(result.balances, []);
});
