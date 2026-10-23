import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatTransactionState,
  getLatestTxHash,
  hasUnacknowledgedError,
  isNotPaidInTime,
  isPaymentNeverReceived,
  type Transaction,
} from './transaction-format.helpers';

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

const asStateRow = (partial: {
  type: 'payment' | 'purchase';
  onChainState: string | null;
  currentTxHash?: string | null;
  history?: Array<{ createdAt: string; txHash: string | null }>;
}): Transaction =>
  ({
    ...asTransaction(partial),
    type: partial.type,
    onChainState: partial.onChainState,
  }) as unknown as Transaction;

test('formatTransactionState labels a never-locked timed-out payment as No Payment Received', () => {
  const tx = asStateRow({ type: 'payment', onChainState: 'FundsOrDatumInvalid' });
  assert.equal(isPaymentNeverReceived(tx), true);
  assert.equal(formatTransactionState(tx), 'No Payment Received');
});

test('formatTransactionState keeps Funds or Datum Invalid when a lock tx was observed', () => {
  const tx = asStateRow({
    type: 'payment',
    onChainState: 'FundsOrDatumInvalid',
    history: [{ createdAt: '2024-01-01T00:00:00Z', txHash: 'lock-hash' }],
  });
  assert.equal(isPaymentNeverReceived(tx), false);
  assert.equal(formatTransactionState(tx), 'Funds or Datum Invalid');
});

const asPurchaseRow = (partial: {
  currentStatus?: string;
  historyStatuses?: string[];
}): Transaction =>
  ({
    type: 'purchase',
    onChainState: 'FundsOrDatumInvalid',
    CurrentTransaction: partial.currentStatus
      ? { txHash: 'lock-hash', status: partial.currentStatus }
      : null,
    TransactionHistory: (partial.historyStatuses ?? []).map((status) => ({
      createdAt: new Date('2024-01-01T00:00:00Z'),
      txHash: 'old-hash',
      status,
    })),
  }) as unknown as Transaction;

test('formatTransactionState labels a never-locked timed-out purchase as Not Paid In Time', () => {
  const tx = asPurchaseRow({});
  assert.equal(isNotPaidInTime(tx), true);
  assert.equal(formatTransactionState(tx), 'Not Paid In Time');
});

test('a purchase whose lock tx never confirmed is still Not Paid In Time', () => {
  // The lock tx carries a hash, so the payment-side hash check would miss it.
  const tx = asPurchaseRow({ currentStatus: 'FailedViaTimeout', historyStatuses: ['RolledBack'] });
  assert.equal(formatTransactionState(tx), 'Not Paid In Time');
});

test('a purchase with a confirmed invalid lock keeps Funds or Datum Invalid', () => {
  assert.equal(
    formatTransactionState(asPurchaseRow({ currentStatus: 'Confirmed' })),
    'Funds or Datum Invalid',
  );
  assert.equal(isNotPaidInTime(asPurchaseRow({ historyStatuses: ['Confirmed'] })), false);
});

test('hasUnacknowledgedError drops the error highlight once acknowledged', () => {
  const withNextAction = (manualActionAcknowledgedAt: Date | null | undefined) =>
    ({
      NextAction: { errorType: 'Unknown', manualActionAcknowledgedAt },
    }) as unknown as Transaction;
  assert.equal(hasUnacknowledgedError(withNextAction(null)), true);
  assert.equal(hasUnacknowledgedError(withNextAction(undefined)), true);
  assert.equal(hasUnacknowledgedError(withNextAction(new Date())), false);
});
