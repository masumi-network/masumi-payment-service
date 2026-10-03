import assert from 'node:assert/strict';
import test from 'node:test';
import { buildX402TransactionScope } from './x402-transactions';

test('transactions wait for an active chain instead of querying every chain', () => {
  assert.deepEqual(
    buildX402TransactionScope({ status: 'Settled', caip2Network: 'eip155:1' }, undefined),
    {
      filters: { status: 'Settled', caip2Network: undefined },
      isEnabled: false,
    },
  );
});

test('transactions always replace stale chain scope with the active source', () => {
  assert.deepEqual(
    buildX402TransactionScope({ side: 'buy', caip2Network: 'eip155:1' }, 'eip155:84532'),
    {
      filters: { side: 'buy', caip2Network: 'eip155:84532' },
      isEnabled: true,
    },
  );
});
