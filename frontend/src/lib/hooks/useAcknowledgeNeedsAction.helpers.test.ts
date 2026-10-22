import assert from 'node:assert/strict';
import test from 'node:test';
import type { Transaction } from '@/components/transactions/transaction-format.helpers';
import {
  ACKNOWLEDGE_BATCH_SIZE,
  buildAcknowledgeBatches,
} from './useAcknowledgeNeedsAction.helpers';

const row = (type: 'payment' | 'purchase', id: string, network: string | null = 'Preprod') =>
  ({
    type,
    blockchainIdentifier: id,
    PaymentSource: network ? { network } : undefined,
  }) as unknown as Transaction;

test('a payment and its paired purchase with the same identifier are both sent', () => {
  const batches = buildAcknowledgeBatches(
    [row('payment', 'shared'), row('purchase', 'shared')],
    null,
  );
  assert.deepEqual(
    batches.map((b) => [b.type, b.blockchainIdentifiers]),
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
    batches.map((b) => [b.network, b.blockchainIdentifiers]),
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
    batches.map((b) => b.blockchainIdentifiers.length),
    [ACKNOWLEDGE_BATCH_SIZE, 1],
  );
});
