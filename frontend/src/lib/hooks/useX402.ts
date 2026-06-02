import { useCallback, useMemo } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useAppContext } from '@/lib/contexts/AppContext';
import {
  getX402Budgets,
  getX402Networks,
  getX402Payments,
  getX402Wallets,
  X402Budget,
  X402Network,
  X402PaymentAttempt,
  X402Wallet,
} from '@/lib/api/generated';
import { handleApiCall } from '@/lib/utils';
import { flattenInclusiveCursorPages } from '@/lib/pagination/cursor-pagination';

const PAGE_SIZE = 20;

export function useX402Networks(options?: { silentErrors?: boolean }) {
  const { apiClient, authorized } = useAppContext();
  const silentErrors = options?.silentErrors ?? false;

  const query = useQuery({
    queryKey: ['x402-networks'],
    queryFn: async () => {
      const response = await handleApiCall(
        () => getX402Networks({ client: apiClient }),
        // The selector renders this for every key, including non-admins that get a 401.
        // Stay silent there and fall back to an empty list instead of toasting.
        silentErrors ? { onError: () => {} } : { errorMessage: 'Failed to fetch chains' },
      );
      return response?.data?.data?.Networks ?? [];
    },
    enabled: !!apiClient && authorized,
    staleTime: 30000,
  });

  return {
    networks: (query.data ?? []) as X402Network[],
    isLoading: query.isLoading,
    isRefetching: query.isRefetching,
    refetch: async () => {
      await query.refetch();
    },
  };
}

export function useX402Wallets() {
  const { apiClient, authorized } = useAppContext();

  const query = useQuery({
    queryKey: ['x402-wallets'],
    queryFn: async () => {
      const response = await handleApiCall(() => getX402Wallets({ client: apiClient }), {
        errorMessage: 'Failed to fetch wallets',
      });
      return response?.data?.data?.Wallets ?? [];
    },
    enabled: !!apiClient && authorized,
    staleTime: 30000,
  });

  return {
    wallets: (query.data ?? []) as X402Wallet[],
    isLoading: query.isLoading,
    isRefetching: query.isRefetching,
    refetch: async () => {
      await query.refetch();
    },
  };
}

export function useX402Budgets() {
  const { apiClient, authorized } = useAppContext();

  const query = useQuery({
    queryKey: ['x402-budgets'],
    queryFn: async () => {
      const response = await handleApiCall(() => getX402Budgets({ client: apiClient, query: {} }), {
        errorMessage: 'Failed to fetch budgets',
      });
      return response?.data?.data?.Budgets ?? [];
    },
    enabled: !!apiClient && authorized,
    staleTime: 30000,
  });

  return {
    budgets: (query.data ?? []) as X402Budget[],
    isLoading: query.isLoading,
    isRefetching: query.isRefetching,
    refetch: async () => {
      await query.refetch();
    },
  };
}

export type X402PaymentFilters = {
  status?: X402PaymentAttempt['status'];
  direction?: X402PaymentAttempt['direction'];
  caip2Network?: string;
};

export function useX402PaymentAttempts(filters: X402PaymentFilters = {}) {
  const { apiClient, authorized } = useAppContext();

  const query = useInfiniteQuery({
    queryKey: [
      'x402-payments',
      filters.status ?? null,
      filters.direction ?? null,
      filters.caip2Network ?? null,
    ],
    queryFn: async ({ pageParam }) => {
      const response = await handleApiCall(
        () =>
          getX402Payments({
            client: apiClient,
            query: {
              take: PAGE_SIZE,
              cursorId: pageParam ?? undefined,
              status: filters.status,
              direction: filters.direction,
              caip2Network: filters.caip2Network,
            },
          }),
        { errorMessage: 'Failed to fetch x402 payments' },
      );

      const attempts = response?.data?.data?.PaymentAttempts ?? [];
      const hasMore = attempts.length === PAGE_SIZE;
      const nextCursor = hasMore ? (attempts[attempts.length - 1]?.id ?? undefined) : undefined;
      return { attempts, nextCursor, hasMore };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined,
    enabled: !!apiClient && authorized,
    staleTime: 15000,
  });

  const attempts = useMemo(() => {
    const pages = query.data?.pages ?? [];
    return flattenInclusiveCursorPages(
      pages.map((page) => page.attempts),
      (attempt: X402PaymentAttempt) => attempt.id,
    );
  }, [query.data]);

  const loadMore = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) {
      query.fetchNextPage();
    }
  }, [query]);

  return {
    attempts,
    isLoading: query.isLoading,
    hasMore: Boolean(query.hasNextPage),
    isFetchingNextPage: query.isFetchingNextPage,
    loadMore,
    refetch: async () => {
      await query.refetch();
    },
    isRefetching: query.isRefetching,
  };
}
