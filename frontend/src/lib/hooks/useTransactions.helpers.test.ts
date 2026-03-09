import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTransactionsPage,
  dedupeTransactions,
  type PaymentTx,
  type PurchaseTx,
} from './useTransactions.helpers';

const createPayment = (id: string, createdAt: string): PaymentTx =>
  ({
    id,
    createdAt,
    type: 'payment',
  }) as unknown as PaymentTx;

const createPurchase = (id: string, createdAt: string): PurchaseTx =>
  ({
    id,
    createdAt,
    type: 'purchase',
  }) as unknown as PurchaseTx;

test('buildTransactionsPage keeps separate cursors for payments and purchases', () => {
  const page = buildTransactionsPage({
    payments: [createPayment('payment-2', '2024-01-02T00:00:00.000Z')],
    purchases: [createPurchase('purchase-3', '2024-01-03T00:00:00.000Z')],
    pageSize: 1,
    skipPayments: false,
    skipPurchases: false,
  });

  assert.equal(page.hasMore, true);
  assert.deepEqual(page.nextPageParam, {
    paymentCursorId: 'payment-2',
    purchaseCursorId: 'purchase-3',
    hasMorePayments: true,
    hasMorePurchases: true,
  });
  assert.deepEqual(
    page.transactions.map((transaction) => transaction.id),
    ['purchase-3', 'payment-2'],
  );
});

test('dedupeTransactions preserves newest-first ordering across merged pages', () => {
  const transactions = dedupeTransactions([
    createPayment('payment-1', '2024-01-01T00:00:00.000Z'),
    createPurchase('purchase-1', '2024-01-03T00:00:00.000Z'),
    createPayment('payment-1', '2024-01-01T00:00:00.000Z'),
    createPurchase('purchase-2', '2024-01-02T00:00:00.000Z'),
  ]);

  assert.deepEqual(
    transactions.map((transaction) => transaction.id),
    ['purchase-1', 'purchase-2', 'payment-1'],
  );
});
