import { Payment, Purchase } from '@/lib/api/generated';

type HydraAwareTransactionRecord = {
  layer?: 'L1' | 'L2';
  hydraHeadId?: string | null;
};

export type PaymentTx = Omit<Payment, 'CurrentTransaction' | 'TransactionHistory'> & {
  type: 'payment';
  RequestedFunds?: { amount: string; unit: string }[];
  Amounts?: { amount: string; unit: string }[];
  unlockTime?: string | null;
  CurrentTransaction:
    | (NonNullable<Payment['CurrentTransaction']> & HydraAwareTransactionRecord)
    | null;
  TransactionHistory: Array<
    NonNullable<NonNullable<Payment['TransactionHistory']>[number]> & HydraAwareTransactionRecord
  > | null;
  PaymentSource: Payment['PaymentSource'] & {
    id?: string;
  };
};

export type PurchaseTx = Omit<Purchase, 'CurrentTransaction' | 'TransactionHistory'> & {
  type: 'purchase';
  PaidFunds?: { amount: string; unit: string }[];
  Amounts?: { amount: string; unit: string }[];
  unlockTime?: string | null;
  CurrentTransaction:
    | (NonNullable<Purchase['CurrentTransaction']> & HydraAwareTransactionRecord)
    | null;
  TransactionHistory: Array<
    NonNullable<NonNullable<Purchase['TransactionHistory']>[number]> & HydraAwareTransactionRecord
  > | null;
  PaymentSource: Purchase['PaymentSource'] & {
    id?: string;
  };
};

export type Transaction = PaymentTx | PurchaseTx;

export type TransactionsPageParam = {
  paymentCursorId?: string;
  purchaseCursorId?: string;
  hasMorePayments?: boolean;
  hasMorePurchases?: boolean;
};

export type TransactionsPage = {
  transactions: Transaction[];
  hasMore: boolean;
  nextPageParam?: TransactionsPageParam;
};

const sortTransactionsByCreatedAt = (transactions: Transaction[]) =>
  [...transactions].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );

export function buildPaymentTransactions(payments: Payment[]): PaymentTx[] {
  return payments.map((payment) => ({
    ...payment,
    type: 'payment',
  }));
}

export function buildPurchaseTransactions(purchases: Purchase[]): PurchaseTx[] {
  return purchases.map((purchase) => ({
    ...purchase,
    type: 'purchase',
  }));
}

export function dedupeTransactions(transactions: Transaction[]): Transaction[] {
  const seen = new Set<string>();
  const unique: Transaction[] = [];

  transactions.forEach((transaction) => {
    if (transaction.id) {
      if (seen.has(transaction.id)) {
        return;
      }
      seen.add(transaction.id);
    }
    unique.push(transaction);
  });

  return sortTransactionsByCreatedAt(unique);
}

export function buildTransactionsPage(options: {
  payments: Payment[];
  purchases: Purchase[];
  pageSize: number;
  skipPayments: boolean;
  skipPurchases: boolean;
}): TransactionsPage {
  const paymentTransactions = options.skipPayments
    ? []
    : buildPaymentTransactions(options.payments);
  const purchaseTransactions = options.skipPurchases
    ? []
    : buildPurchaseTransactions(options.purchases);
  const hasMorePayments = !options.skipPayments && options.payments.length === options.pageSize;
  const hasMorePurchases = !options.skipPurchases && options.purchases.length === options.pageSize;
  const hasMore = hasMorePayments || hasMorePurchases;

  return {
    transactions: sortTransactionsByCreatedAt([...purchaseTransactions, ...paymentTransactions]),
    hasMore,
    nextPageParam: hasMore
      ? {
          paymentCursorId: hasMorePayments
            ? paymentTransactions[paymentTransactions.length - 1]?.id
            : undefined,
          purchaseCursorId: hasMorePurchases
            ? purchaseTransactions[purchaseTransactions.length - 1]?.id
            : undefined,
          hasMorePayments,
          hasMorePurchases,
        }
      : undefined,
  };
}
