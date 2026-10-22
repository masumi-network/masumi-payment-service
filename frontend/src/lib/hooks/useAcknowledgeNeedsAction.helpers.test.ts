import assert from 'node:assert/strict';
import test from 'node:test';
import type { Transaction } from '@/components/transactions/transaction-format.helpers';
import {
  ACKNOWLEDGE_BATCH_SIZE,
  buildAcknowledgeBatches,
} from './useAcknowledgeNeedsAction.helpers';

const CHANGED_AT = '2026-10-22T08:15:30.123Z';

const row = (type: 'payment' | 'purchase', id: string, network: string | null = 'Preprod') =>
  ({
    type,
    blockchainIdentifier: id,
    nextActionLastChangedAt: CHANGED_AT,
    PaymentSource: network ? { network } : undefined,
  }) as unknown as Transaction;

test('a payment and its paired purchase with the same identifier are both sent', () => {
  const batches = buildAcknowledgeBatches(
    [row('payment', 'shared'), row('purchase', 'shared')],
    null,
  );
  assert.deepEqual(
    batches.map((b) => [b.type, b.requests.map((r) => r.blockchainIdentifier)]),
    [
      ['payment', ['shared']],
      ['purchase', ['shared']],
    ],
  );
});

test('rows are split by network and fall back to the context network', () => {
  const batches = buildAcknowledgeBatches(
    [row('payment', 'a', 'Mainnet'), row('payment', 'b', null), row('payment', 'c', 'Unknown')],
    'Preprod',
  );
  assert.deepEqual(
    batches.map((b) => [b.network, b.requests.map((r) => r.blockchainIdentifier)]),
    [
      ['Mainnet', ['a']],
      ['Preprod', ['b']],
    ],
  );
});

test('a group larger than the backend limit is chunked', () => {
  const rows = Array.from({ length: ACKNOWLEDGE_BATCH_SIZE + 1 }, (_, i) =>
    row('purchase', `id-${i}`),
  );
  const batches = buildAcknowledgeBatches(rows, null);
  assert.deepEqual(
    batches.map((b) => b.requests.length),
    [ACKNOWLEDGE_BATCH_SIZE, 1],
  );
});

// The backend matches the timestamp exactly, so a Date and an ISO string must
// give the same instant.
test('each request carries the change time it was read with', () => {
  const asDate = {
    ...row('payment', 'a'),
    nextActionLastChangedAt: new Date(CHANGED_AT),
  } as Transaction;
  const batches = buildAcknowledgeBatches([asDate, row('payment', 'b')], null);
  assert.deepEqual(batches[0]?.requests, [
    { blockchainIdentifier: 'a', nextActionLastChangedAt: new Date(CHANGED_AT) },
    { blockchainIdentifier: 'b', nextActionLastChangedAt: new Date(CHANGED_AT) },
  ]);
});
