/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable react-hooks/exhaustive-deps */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { useAppContext } from '@/lib/contexts/AppContext';
import { getPayment, getPurchase } from '@/lib/api/generated';
import { handleApiCall } from '@/lib/utils';

interface Transaction {
  id: string;
  type: 'payment' | 'purchase';
  createdAt: string;
  updatedAt: string;
  onChainState: string;
  Amounts: Array<{
    amount: string;
    unit: string;
  }>;
  PaymentSource: {
    network: 'Preprod' | 'Mainnet';
    paymentType: string;
  };
  CurrentTransaction?: {
    txHash: string | null;
  } | null;
  NextAction?: {
    errorType?: string;
    errorNote?: string | null;
  };
  SmartContractWallet?: {
    walletAddress: string;
  } | null;
}

const LAST_VISIT_KEY = 'masumi_last_transactions_visit';
const NEW_TRANSACTIONS_COUNT_KEY = 'masumi_new_transactions_count';

export function useTransactions() {
  const { apiClient } = useAppContext();
  const router = useRouter();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [hasMore, setHasMore] = useState(true);
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [newTransactionsCount, setNewTransactionsCount] = useState(0);

  // Get last visit timestamp from localStorage
  const getLastVisitTimestamp = (): string | null => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(LAST_VISIT_KEY);
  };

  // Set last visit timestamp in localStorage
  const setLastVisitTimestamp = (timestamp: string) => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(LAST_VISIT_KEY, timestamp);
  };

  // Get new transactions count from localStorage
  const getNewTransactionsCount = (): number => {
    if (typeof window === 'undefined') return 0;
    const count = localStorage.getItem(NEW_TRANSACTIONS_COUNT_KEY);
    return count ? parseInt(count, 10) : 0;
  };

  // Set new transactions count in localStorage
  const setNewTransactionsCountInStorage = (count: number) => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(NEW_TRANSACTIONS_COUNT_KEY, count.toString());
  };

  const fetchTransactions = useCallback(
    async (cursor?: string, checkForNew = false) => {
      setIsLoading(true);
      const combined: Transaction[] = [];

      const purchases = await handleApiCall(
        () =>
          getPurchase({
            client: apiClient,
            query: {
              network: 'Preprod',
              cursorId: cursor,
              includeHistory: 'true',
              limit: 10,
            },
          }),
        {
          onError: (error: any) => {
            console.error('Failed to fetch purchases:', error);
          },
          errorMessage: 'Failed to fetch purchases',
        },
      );

      if (purchases?.data?.data?.Purchases) {
        purchases.data.data.Purchases.forEach((purchase: any) => {
          combined.push({
            ...purchase,
            type: 'purchase',
          });
        });
      }

      const payments = await handleApiCall(
        () =>
          getPayment({
            client: apiClient,
            query: {
              network: 'Preprod',
              cursorId: cursor,
              includeHistory: 'true',
              limit: 10,
            },
          }),
        {
          onError: (error: any) => {
            console.error('Failed to fetch payments:', error);
          },
          errorMessage: 'Failed to fetch payments',
        },
      );

      if (payments?.data?.data?.Payments) {
        payments.data.data.Payments.forEach((payment: any) => {
          combined.push({
            ...payment,
            type: 'payment',
          });
        });
      }

      const newTransactions = combined.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );

      if (checkForNew) {
        const lastVisitTimestamp = getLastVisitTimestamp();
        if (lastVisitTimestamp) {
          const existingIds = new Set(transactions.map((tx) => tx.id));
          const trulyNewTransactions = newTransactions.filter(
            (tx) =>
              !existingIds.has(tx.id) &&
              new Date(tx.createdAt) > new Date(lastVisitTimestamp),
          );

          const currentCount = getNewTransactionsCount();
          const newCount = currentCount + trulyNewTransactions.length;
          setNewTransactionsCount(newCount);
          setNewTransactionsCountInStorage(newCount);
        }
      }

      if (!checkForNew) {
        const existingIds = new Set(transactions.map((tx) => tx.id));
        const uniqueNewTransactions = newTransactions.filter(
          (tx) => !existingIds.has(tx.id),
        );

        setTransactions((prev) =>
          cursor ? [...prev, ...uniqueNewTransactions] : uniqueNewTransactions,
        );
        setHasMore(
          purchases?.data?.data?.Purchases?.length === 10 ||
            payments?.data?.data?.Payments?.length === 10,
        );
        setCursorId(newTransactions[newTransactions.length - 1]?.id ?? null);
      }

      setIsLoading(false);
    },
    [apiClient, transactions],
  );

  useEffect(() => {
    fetchTransactions();
    // Initialize new transactions count from localStorage
    const storedCount = getNewTransactionsCount();
    setNewTransactionsCount(storedCount);
  }, [apiClient]);

  useEffect(() => {
    const interval = setInterval(() => {
      fetchTransactions(undefined, true);
    }, 60000);

    return () => clearInterval(interval);
  }, [fetchTransactions]);

  useEffect(() => {
    if (router.pathname === '/transactions' && newTransactionsCount > 0) {
      setNewTransactionsCount(0);
      setNewTransactionsCountInStorage(0);
      setLastVisitTimestamp(new Date().toISOString());
    }
  }, [router.pathname, newTransactionsCount]);

  const markAllAsRead = useCallback(() => {
    setNewTransactionsCount(0);
    setNewTransactionsCountInStorage(0);
    setLastVisitTimestamp(new Date().toISOString());
  }, []);

  const loadMore = useCallback(() => {
    if (cursorId && !isLoading) {
      fetchTransactions(cursorId);
    }
  }, [cursorId, isLoading, fetchTransactions]);

  return {
    transactions,
    isLoading,
    hasMore,
    loadMore,
    newTransactionsCount,
    markAllAsRead,
  };
}
