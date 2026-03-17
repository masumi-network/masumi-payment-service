import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { useRouter } from 'next/router';
import { getPayment, getPurchase, type Payment, type Purchase } from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';
import { handleApiCall } from '@/lib/utils';
import {
  buildTransactionsPage,
  dedupeTransactions,
  type TransactionsPage,
  type TransactionsPageParam,
} from './useTransactions.helpers';

const LAST_VISIT_KEY = 'masumi_last_transactions_visit';
const NEW_TRANSACTIONS_COUNT_KEY = 'masumi_new_transactions_count';
const TRANSACTION_PAGE_SIZE = 10;

export const ON_CHAIN_STATES = [
  'FundsLocked',
  'FundsOrDatumInvalid',
  'ResultSubmitted',
  'RefundRequested',
  'Disputed',
  'Withdrawn',
  'RefundWithdrawn',
  'DisputedWithdrawn',
] as const;

export type OnChainStateFilter = (typeof ON_CHAIN_STATES)[number];

type TransactionQueryParams = {
  filterOnChainState?: OnChainStateFilter;
  searchQuery?: string;
  transactionType?: 'payment' | 'purchase';
};

type PaymentApiResponse = Awaited<ReturnType<typeof getPayment>>;
type PurchaseApiResponse = Awaited<ReturnType<typeof getPurchase>>;

const getLastVisitTimestamp = (): string | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  return localStorage.getItem(LAST_VISIT_KEY);
};

const setLastVisitTimestamp = (timestamp: string) => {
  if (typeof window === 'undefined') {
    return;
  }

  localStorage.setItem(LAST_VISIT_KEY, timestamp);
};

const getStoredNewTransactionsCount = (): number => {
  if (typeof window === 'undefined') {
    return 0;
  }

  const count = localStorage.getItem(NEW_TRANSACTIONS_COUNT_KEY);
  return count ? Number.parseInt(count, 10) : 0;
};

const setStoredNewTransactionsCount = (count: number) => {
  if (typeof window === 'undefined') {
    return;
  }

  localStorage.setItem(NEW_TRANSACTIONS_COUNT_KEY, count.toString());
};

const logFetchFailure = (kind: 'payments' | 'purchases', error: unknown) => {
  console.error(`Failed to fetch ${kind}:`, error);
};

const getPaymentsFromResponse = (response: PaymentApiResponse | null): Payment[] =>
  response?.data?.data?.Payments ?? [];

const getPurchasesFromResponse = (response: PurchaseApiResponse | null): Purchase[] =>
  response?.data?.data?.Purchases ?? [];

export function useTransactions(
  params?: TransactionQueryParams,
  options?: { trackVisit?: boolean },
) {
  const trackVisit = options?.trackVisit !== false;
  const { apiClient, network } = useAppContext();
  const router = useRouter();
  const [newTransactionsCount, setNewTransactionsCount] = useState(0);
  const seenTransactionIdsRef = useRef<Set<string>>(new Set());
  const lastFetchWasNextPageRef = useRef(false);
  const hasInitializedRef = useRef(false);
  const previousNetworkRef = useRef(network);

  const query = useInfiniteQuery({
    queryKey: [
      'transactions',
      network,
      params?.filterOnChainState,
      params?.searchQuery,
      params?.transactionType,
    ],
    queryFn: async ({ pageParam }) => {
      const cursorState = pageParam as TransactionsPageParam | undefined;
      const skipPurchases = params?.transactionType === 'payment';
      const skipPayments = params?.transactionType === 'purchase';
      const shouldFetchPurchases = !skipPurchases && cursorState?.hasMorePurchases !== false;
      const shouldFetchPayments = !skipPayments && cursorState?.hasMorePayments !== false;

      const purchases = shouldFetchPurchases
        ? await handleApiCall(
            () =>
              getPurchase({
                client: apiClient,
                query: {
                  network,
                  cursorId: cursorState?.purchaseCursorId,
                  includeHistory: 'true',
                  limit: TRANSACTION_PAGE_SIZE,
                  filterOnChainState: params?.filterOnChainState,
                  searchQuery: params?.searchQuery || undefined,
                },
              }),
            {
              onError: (error: unknown) => {
                logFetchFailure('purchases', error);
              },
              errorMessage: 'Failed to fetch purchases',
            },
          )
        : null;

      const payments = shouldFetchPayments
        ? await handleApiCall(
            () =>
              getPayment({
                client: apiClient,
                query: {
                  network,
                  cursorId: cursorState?.paymentCursorId,
                  includeHistory: 'true',
                  limit: TRANSACTION_PAGE_SIZE,
                  filterOnChainState: params?.filterOnChainState,
                  searchQuery: params?.searchQuery || undefined,
                },
              }),
            {
              onError: (error: unknown) => {
                logFetchFailure('payments', error);
              },
              errorMessage: 'Failed to fetch payments',
            },
          )
        : null;

      return buildTransactionsPage({
        payments: getPaymentsFromResponse(payments),
        purchases: getPurchasesFromResponse(purchases),
        pageSize: TRANSACTION_PAGE_SIZE,
        skipPayments,
        skipPurchases,
      });
    },
    initialPageParam: undefined as TransactionsPageParam | undefined,
    getNextPageParam: (lastPage: TransactionsPage) => lastPage.nextPageParam,
    refetchInterval: 25000,
    enabled: !!apiClient,
    staleTime: 15000,
    placeholderData: keepPreviousData,
  });

  const transactions = useMemo(() => {
    const pages = query.data?.pages ?? [];
    return dedupeTransactions(pages.flatMap((page) => page.transactions));
  }, [query.data]);

  const isLoading = query.isLoading;
  const isPlaceholderData = query.isPlaceholderData;
  const hasMore = Boolean(query.hasNextPage);
  const isFetchingNextPage = query.isFetchingNextPage;
  const isRefetching = query.isRefetching;
  const refetch = query.refetch;

  useEffect(() => {
    if (!trackVisit) {
      return;
    }

    if (previousNetworkRef.current !== network) {
      hasInitializedRef.current = false;
      seenTransactionIdsRef.current = new Set();
      lastFetchWasNextPageRef.current = false;

      // eslint-disable-next-line react-hooks/set-state-in-effect -- Reset unread state immediately when the active network changes.
      setNewTransactionsCount(0);
      setStoredNewTransactionsCount(0);
      setLastVisitTimestamp(new Date().toISOString());

      previousNetworkRef.current = network;
    }
  }, [network, trackVisit]);

  useEffect(() => {
    if (!trackVisit) {
      return;
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect -- Hydrating the unread counter from localStorage keeps this hook as the single source of truth.
    setNewTransactionsCount(getStoredNewTransactionsCount());
  }, [trackVisit]);

  useEffect(() => {
    if (!trackVisit || !query.data) {
      return;
    }

    if (!hasInitializedRef.current) {
      seenTransactionIdsRef.current = new Set(
        transactions.map((transaction) => transaction.id ?? ''),
      );
      hasInitializedRef.current = true;
      return;
    }

    if (lastFetchWasNextPageRef.current) {
      seenTransactionIdsRef.current = new Set([
        ...seenTransactionIdsRef.current,
        ...transactions.map((transaction) => transaction.id ?? ''),
      ]);
      lastFetchWasNextPageRef.current = false;
      return;
    }

    const lastVisitTimestamp = getLastVisitTimestamp();
    if (!lastVisitTimestamp) {
      seenTransactionIdsRef.current = new Set(
        transactions.map((transaction) => transaction.id ?? ''),
      );
      return;
    }

    const currentCount = getStoredNewTransactionsCount();
    const existingIds = seenTransactionIdsRef.current;
    const newTransactions = transactions.filter(
      (transaction) =>
        !existingIds.has(transaction.id ?? '') &&
        new Date(transaction.createdAt) > new Date(lastVisitTimestamp),
    );

    if (newTransactions.length > 0) {
      const updatedCount = currentCount + newTransactions.length;
      setNewTransactionsCount(updatedCount);
      setStoredNewTransactionsCount(updatedCount);
    }

    seenTransactionIdsRef.current = new Set([
      ...existingIds,
      ...transactions.map((transaction) => transaction.id ?? ''),
    ]);
  }, [query.data, query.dataUpdatedAt, trackVisit, transactions]);

  useEffect(() => {
    if (!trackVisit) {
      return;
    }

    if (router.pathname === '/transactions' && newTransactionsCount > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Opening the transactions page should clear the badge immediately.
      setNewTransactionsCount(0);
      setStoredNewTransactionsCount(0);
      setLastVisitTimestamp(new Date().toISOString());
      seenTransactionIdsRef.current = new Set(
        transactions.map((transaction) => transaction.id ?? ''),
      );
    }
  }, [newTransactionsCount, router.pathname, trackVisit, transactions]);

  const markAllAsRead = useCallback(() => {
    if (!trackVisit) {
      return;
    }

    setNewTransactionsCount(0);
    setStoredNewTransactionsCount(0);
    setLastVisitTimestamp(new Date().toISOString());
    seenTransactionIdsRef.current = new Set(
      transactions.map((transaction) => transaction.id ?? ''),
    );
  }, [trackVisit, transactions]);

  const loadMore = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) {
      lastFetchWasNextPageRef.current = true;
      void query.fetchNextPage();
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
    isFetching: query.isFetching,
    refetch,
    isRefetching,
    isPlaceholderData,
  };
}
