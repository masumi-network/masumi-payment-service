import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DOWNLOAD_PAGE_SIZE,
  buildTransactionDownloadQuery,
  mergeDownloadedTransactions,
} from './download-details.helpers';

test('buildTransactionDownloadQuery keeps the active network in CSV export requests', () => {
  assert.deepEqual(buildTransactionDownloadQuery('Mainnet', 'cursor-1'), {
    network: 'Mainnet',
    cursorId: 'cursor-1',
    includeHistory: 'true',
    limit: DOWNLOAD_PAGE_SIZE,
  });
});

test('mergeDownloadedTransactions removes the inclusive cursor overlap row', () => {
  const merged = mergeDownloadedTransactions(
    [
      { id: 'purchase-1', type: 'purchase' },
      { id: 'payment-1', type: 'payment' },
    ] as never[],
    [
      { id: 'payment-1', type: 'payment' },
      { id: 'payment-2', type: 'payment' },
    ] as never[],
  );

  assert.deepEqual(
    merged.map((transaction) => `${transaction.type}:${transaction.id}`),
    ['purchase:purchase-1', 'payment:payment-1', 'payment:payment-2'],
  );
});
