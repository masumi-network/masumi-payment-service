/* eslint-disable react-hooks/exhaustive-deps */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useRouter } from 'next/router';
import { useAppContext } from '@/lib/contexts/AppContext';
import { getPayment, getPurchase, Payment, Purchase } from '@/lib/api/generated';
import { handleApiCall } from '@/lib/utils';

type PaymentTx = Payment & {
  type: 'payment';
  RequestedFunds?: { amount: string; unit: string }[];
  Amounts?: { amount: string; unit: string }[];
  unlockTime?: string | null;
  PaymentSource: Payment['PaymentSource'] & {
    id?: string;
  };
};

type PurchaseTx = Purchase & {
  type: 'purchase';
  PaidFunds?: { amount: string; unit: string }[];
  Amounts?: { amount: string; unit: string }[];
  unlockTime?: string | null;
  PaymentSource: Purchase['PaymentSource'] & {
    id?: string;
  };
};

type Transaction = PaymentTx | PurchaseTx;

const LAST_VISIT_KEY = 'masumi_last_transactions_visit';
const NEW_TRANSACTIONS_COUNT_KEY = 'masumi_new_transactions_count';

export function useTransactions() {
  const { apiClient, network } = useAppContext();
  const router = useRouter();
  const [newTransactionsCount, setNewTransactionsCount] = useState(0);
  const seenTransactionIdsRef = useRef<Set<string>>(new Set());
  const lastFetchWasNextPageRef = useRef(false);
  const hasInitializedRef = useRef(false);
  const previousNetworkRef = useRef(network);

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

  const query = useInfiniteQuery({
    queryKey: ['transactions', network],
    queryFn: async ({ pageParam }) => {
      const combined: Transaction[] = [];
      const cursor = pageParam ?? undefined;

      const purchases = await handleApiCall(
        () =>
          getPurchase({
            client: apiClient,
            query: {
              network,
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
              network,
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

      const sortedTransactions = combined.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );

      const purchasesCount = purchases?.data?.data?.Purchases?.length ?? 0;
      const paymentsCount = payments?.data?.data?.Payments?.length ?? 0;
      const hasMore = purchasesCount === 10 || paymentsCount === 10;
      const nextCursor = hasMore
        ? (sortedTransactions[sortedTransactions.length - 1]?.id ?? undefined)
        : undefined;

      return {
        transactions: sortedTransactions,
        nextCursor,
        hasMore,
      };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined,
    refetchInterval: 25000,
    enabled: !!apiClient,
    staleTime: 15000,
  });

  const transactions = useMemo(() => {
    const pages = query.data?.pages ?? [];
    const combined = pages.flatMap((page) => page.transactions);
    const seen = new Set<string>();
    const unique: Transaction[] = [];

    combined.forEach((tx) => {
      if (tx.id) {
        if (seen.has(tx.id)) return;
        seen.add(tx.id);
      }
      unique.push(tx);
    });

    return unique.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [query.data]);

  const isLoading = query.isLoading || query.isRefetching;
  const hasMore = Boolean(query.hasNextPage);
  const isFetchingNextPage = query.isFetchingNextPage;
  const isRefetching = query.isRefetching;
  const refetch = query.refetch;

  useEffect(() => {
    if (previousNetworkRef.current !== network) {
      hasInitializedRef.current = false;
      seenTransactionIdsRef.current = new Set();
      lastFetchWasNextPageRef.current = false;

      setNewTransactionsCount(0);
      setNewTransactionsCountInStorage(0);

      setLastVisitTimestamp(new Date().toISOString());

      previousNetworkRef.current = network;
    }
  }, [network]);

  useEffect(() => {
    const storedCount = getNewTransactionsCount();
    setNewTransactionsCount(storedCount);
  }, []);

  useEffect(() => {
    if (!query.data) return;

    if (!hasInitializedRef.current) {
      seenTransactionIdsRef.current = new Set(transactions.map((tx) => tx.id ?? ''));
      hasInitializedRef.current = true;
      return;
    }

    if (lastFetchWasNextPageRef.current) {
      seenTransactionIdsRef.current = new Set([
        ...seenTransactionIdsRef.current,
        ...transactions.map((tx) => tx.id ?? ''),
      ]);
      lastFetchWasNextPageRef.current = false;
      return;
    }

    const lastVisitTimestamp = getLastVisitTimestamp();
    if (!lastVisitTimestamp) {
      seenTransactionIdsRef.current = new Set(transactions.map((tx) => tx.id ?? ''));
      return;
    }

    const currentCount = getNewTransactionsCount();
    const existingIds = seenTransactionIdsRef.current;
    const newOnes = transactions.filter(
      (tx) =>
        !existingIds.has(tx.id ?? '') && new Date(tx.createdAt) > new Date(lastVisitTimestamp),
    );

    if (newOnes.length > 0) {
      const newCount = currentCount + newOnes.length;
      setNewTransactionsCount(newCount);
      setNewTransactionsCountInStorage(newCount);
    }

    seenTransactionIdsRef.current = new Set([
      ...existingIds,
      ...transactions.map((tx) => tx.id ?? ''),
    ]);
  }, [query.dataUpdatedAt, transactions]);

  useEffect(() => {
    if (router.pathname === '/transactions' && newTransactionsCount > 0) {
      setNewTransactionsCount(0);
      setNewTransactionsCountInStorage(0);
      setLastVisitTimestamp(new Date().toISOString());
      seenTransactionIdsRef.current = new Set(transactions.map((tx) => tx.id ?? ''));
    }
  }, [router.pathname, newTransactionsCount, transactions]);

  const markAllAsRead = useCallback(() => {
    setNewTransactionsCount(0);
    setNewTransactionsCountInStorage(0);
    setLastVisitTimestamp(new Date().toISOString());
    seenTransactionIdsRef.current = new Set(transactions.map((tx) => tx.id ?? ''));
  }, [transactions]);

  const loadMore = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) {
      lastFetchWasNextPageRef.current = true;
      query.fetchNextPage();
    }
  }, [query]);

  return {
    transactions,
    isLoading,
    hasMore,
    loadMore,
    newTransactionsCount,
    markAllAsRead,
    isFetchingNextPage,
    refetch,
    isRefetching,
  };
}
