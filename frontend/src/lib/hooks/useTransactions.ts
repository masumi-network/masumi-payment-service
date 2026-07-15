import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
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
import type { PaymentSourceType } from '@/lib/payment-source-type';

const LAST_VISIT_KEY = 'masumi_last_transactions_visit';
const TRANSACTION_PAGE_SIZE = 10;

export const ON_CHAIN_STATES = [
  'FundsLocked',
  'FundsOrDatumInvalid',
  'ResultSubmitted',
  'RefundRequested',
  'Disputed',
  'WithdrawAuthorized',
  'RefundAuthorized',
  'Withdrawn',
  'RefundWithdrawn',
  'DisputedWithdrawn',
] as const;

export type OnChainStateFilter = (typeof ON_CHAIN_STATES)[number];

type TransactionQueryParams = {
  filterOnChainState?: OnChainStateFilter;
  filterPaymentSourceType?: PaymentSourceType;
  /** Only rows needing manual resolution (WaitingForManualAction or recorded error). */
  filterNeedsManualAction?: boolean;
  searchQuery?: string;
  transactionType?: 'payment' | 'purchase';
};

type PaymentApiResponse = Awaited<ReturnType<typeof getPayment>>;
type PurchaseApiResponse = Awaited<ReturnType<typeof getPurchase>>;

// The "new transactions" badge is DERIVED per render from (loaded transactions,
// last-visit timestamp) instead of being incrementally accumulated. Several
// hook instances are mounted at once (layout, dashboard, notifications dialog)
// and an incremental shared counter got bumped once per instance for the same
// transaction, inflating the badge 2-4x. The timestamp lives in localStorage
// (so it survives reloads) behind a module-level store so all instances in the
// tab update together.
const lastVisitListeners = new Set<() => void>();

const subscribeLastVisit = (listener: () => void) => {
  lastVisitListeners.add(listener);
  return () => {
    lastVisitListeners.delete(listener);
  };
};

const getLastVisitTimestamp = (): string | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  return localStorage.getItem(LAST_VISIT_KEY);
};

const getLastVisitServerSnapshot = (): string | null => null;

const setLastVisitTimestamp = (timestamp: string) => {
  if (typeof window === 'undefined') {
    return;
  }

  localStorage.setItem(LAST_VISIT_KEY, timestamp);
  lastVisitListeners.forEach((listener) => listener());
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
  options?: { trackVisit?: boolean; enabled?: boolean },
) {
  const trackVisit = options?.trackVisit !== false;
  const queryEnabled = options?.enabled !== false;
  const { apiClient, network, selectedPaymentSource } = useAppContext();
  const router = useRouter();
  const lastVisitTimestamp = useSyncExternalStore(
    subscribeLastVisit,
    getLastVisitTimestamp,
    getLastVisitServerSnapshot,
  );
  const previousNetworkRef = useRef(network);

  const filterPaymentSourceType =
    params?.filterPaymentSourceType ?? selectedPaymentSource?.paymentSourceType;

  const query = useInfiniteQuery({
    queryKey: [
      'transactions',
      network,
      params?.filterOnChainState,
      filterPaymentSourceType,
      params?.filterNeedsManualAction ?? false,
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
                  filterPaymentSourceType,
                  filterNeedsManualAction: params?.filterNeedsManualAction ? 'true' : undefined,
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
                  filterPaymentSourceType,
                  filterNeedsManualAction: params?.filterNeedsManualAction ? 'true' : undefined,
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
    // No background polling — transactions refresh on mount/refetch and via the
    // manual refresh button. A 25s interval fired requests continuously for
    // every open dashboard/transactions tab.
    enabled: !!apiClient && queryEnabled,
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

  // First-ever use: anchor "new since" to now so historical rows don't all
  // count as new. Idempotent across concurrently mounted instances.
  useEffect(() => {
    if (trackVisit && getLastVisitTimestamp() === null) {
      setLastVisitTimestamp(new Date().toISOString());
    }
  }, [trackVisit]);

  useEffect(() => {
    if (!trackVisit) {
      return;
    }

    if (previousNetworkRef.current !== network) {
      setLastVisitTimestamp(new Date().toISOString());
      previousNetworkRef.current = network;
    }
  }, [network, trackVisit]);

  // "Mark read" watermark. createdAt is a SERVER timestamp; if the client clock
  // runs behind the server, anchoring to the client's `now` leaves rows that are
  // newer-on-the-server above the watermark, so the badge sticks even right after
  // visiting. Take the max of the client clock and the newest loaded row so
  // everything currently visible is definitively marked read.
  const computeReadWatermark = useCallback(() => {
    let watermarkMs = Date.now();
    for (const transaction of transactions) {
      const createdAtMs = new Date(transaction.createdAt).getTime();
      if (createdAtMs > watermarkMs) {
        watermarkMs = createdAtMs;
      }
    }
    return new Date(watermarkMs).toISOString();
  }, [transactions]);

  const newTransactionsCount = useMemo(() => {
    if (!trackVisit || !lastVisitTimestamp) {
      return 0;
    }
    const lastVisit = new Date(lastVisitTimestamp);
    return transactions.filter((transaction) => new Date(transaction.createdAt) > lastVisit).length;
  }, [trackVisit, lastVisitTimestamp, transactions]);

  useEffect(() => {
    if (!trackVisit) {
      return;
    }

    if (router.pathname === '/transactions' && newTransactionsCount > 0) {
      setLastVisitTimestamp(computeReadWatermark());
    }
  }, [newTransactionsCount, router.pathname, trackVisit, computeReadWatermark]);

  const markAllAsRead = useCallback(() => {
    if (!trackVisit) {
      return;
    }

    setLastVisitTimestamp(computeReadWatermark());
  }, [trackVisit, computeReadWatermark]);

  const loadMore = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) {
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
