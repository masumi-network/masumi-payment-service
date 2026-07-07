import assert from 'node:assert/strict';
import test from 'node:test';
import { getLatestTxHash, type Transaction } from './transaction-format.helpers';

const asTransaction = (partial: {
  currentTxHash?: string | null;
  history?: Array<{ createdAt: string; txHash: string | null }>;
}): Transaction =>
  ({
    CurrentTransaction:
      partial.currentTxHash === undefined ? null : { txHash: partial.currentTxHash },
    TransactionHistory: (partial.history ?? []).map((h) => ({
      createdAt: new Date(h.createdAt),
      txHash: h.txHash,
    })),
  }) as unknown as Transaction;

test('getLatestTxHash prefers the current transaction hash', () => {
  const tx = asTransaction({
    currentTxHash: 'current-hash',
    history: [{ createdAt: '2024-01-01T00:00:00Z', txHash: 'old-hash' }],
  });
  assert.equal(getLatestTxHash(tx), 'current-hash');
});

test('getLatestTxHash falls back to the newest historical hash in an error state', () => {
  // Error state: CurrentTransaction has been cleared, but earlier confirmed
  // transactions remain in history. The dash-only regression came from ignoring these.
  const tx = asTransaction({
    currentTxHash: null,
    history: [
      { createdAt: '2024-01-01T00:00:00Z', txHash: 'oldest' },
      { createdAt: '2024-03-01T00:00:00Z', txHash: 'newest' },
      { createdAt: '2024-02-01T00:00:00Z', txHash: 'middle' },
    ],
  });
  assert.equal(getLatestTxHash(tx), 'newest');
});

test('getLatestTxHash skips history rows without a hash', () => {
  const tx = asTransaction({
    currentTxHash: null,
    history: [
      { createdAt: '2024-03-01T00:00:00Z', txHash: null },
      { createdAt: '2024-02-01T00:00:00Z', txHash: 'has-hash' },
    ],
  });
  assert.equal(getLatestTxHash(tx), 'has-hash');
});

test('getLatestTxHash returns null when no hash exists anywhere', () => {
  const tx = asTransaction({
    currentTxHash: null,
    history: [{ createdAt: '2024-01-01T00:00:00Z', txHash: null }],
  });
  assert.equal(getLatestTxHash(tx), null);
});
