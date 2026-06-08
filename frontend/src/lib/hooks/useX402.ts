import { useCallback, useMemo } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useAppContext } from '@/lib/contexts/AppContext';
import {
  getX402Budgets,
  getX402LowBalance,
  getX402Networks,
  getX402Payments,
  getX402Wallets,
  X402Budget,
  X402LowBalanceRule,
  X402Network,
  X402PaymentAttempt,
  X402Wallet,
} from '@/lib/api/generated';
import { handleApiCall } from '@/lib/utils';
import {
  appendInclusiveCursorPage,
  flattenInclusiveCursorPages,
} from '@/lib/pagination/cursor-pagination';

const PAGE_SIZE = 20;

export function useX402Networks(options?: { silentErrors?: boolean }) {
  const { apiClient, authorized } = useAppContext();
  const silentErrors = options?.silentErrors ?? false;

  const query = useQuery({
    // Keyed by silentErrors so the silent (selector) and toasting (tab) consumers do
    // not share one cache entry and race on which onError handler runs.
    queryKey: ['x402-networks', silentErrors],
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

/**
 * Eagerly loads every managed EVM wallet (paging through /x402/wallets). Used by
 * the chain/budget pickers and setup flows that need the full set to choose
 * from. `enabled` lets form dialogs defer the load until opened. Pass `type` to
 * fetch only Purchasing (budget) or Selling (facilitator) wallets. Read-only
 * labels should use the denormalized address on the network/budget instead.
 */
export function useX402Wallets(enabled = true, type?: X402Wallet['type']) {
  const { apiClient, authorized } = useAppContext();

  const query = useQuery({
    queryKey: ['x402-wallets', 'all', type ?? 'any'],
    queryFn: async () => {
      let items: X402Wallet[] = [];
      let cursor: string | undefined;
      while (true) {
        const response = await handleApiCall(
          () =>
            getX402Wallets({
              client: apiClient,
              query: { take: PAGE_SIZE, cursorId: cursor, type },
            }),
          { errorMessage: 'Failed to fetch wallets' },
        );
        const page = (response?.data?.data?.Wallets ?? []) as X402Wallet[];
        if (page.length === 0) break;
        items = appendInclusiveCursorPage(items, page, (wallet) => wallet.id);
        if (page.length < PAGE_SIZE) break;
        const lastWallet = page[page.length - 1];
        if (!lastWallet?.id || lastWallet.id === cursor) break;
        cursor = lastWallet.id;
      }
      return items;
    },
    enabled: !!apiClient && authorized && enabled,
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

/**
 * Cursor-paginated managed EVM wallets for the wallet management list (Load
 * More), so the table doesn't load every wallet up front.
 */
export function useX402WalletsPaginated() {
  const { apiClient, authorized } = useAppContext();

  const query = useInfiniteQuery({
    queryKey: ['x402-wallets', 'paginated'],
    queryFn: async ({ pageParam }) => {
      const response = await handleApiCall(
        () =>
          getX402Wallets({
            client: apiClient,
            query: { take: PAGE_SIZE, cursorId: pageParam ?? undefined },
          }),
        { errorMessage: 'Failed to fetch wallets' },
      );
      const wallets = (response?.data?.data?.Wallets ?? []) as X402Wallet[];
      const hasMore = wallets.length === PAGE_SIZE;
      const nextCursor = hasMore ? (wallets[wallets.length - 1]?.id ?? undefined) : undefined;
      return { wallets, nextCursor, hasMore };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined,
    enabled: !!apiClient && authorized,
    staleTime: 30000,
  });

  const wallets = useMemo(
    () =>
      flattenInclusiveCursorPages(
        (query.data?.pages ?? []).map((page) => page.wallets),
        (wallet) => wallet.id,
      ),
    [query.data],
  );

  const loadMore = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) {
      query.fetchNextPage();
    }
  }, [query]);

  return {
    wallets,
    isLoading: query.isLoading,
    hasMore: Boolean(query.hasNextPage),
    isFetchingNextPage: query.isFetchingNextPage,
    loadMore,
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

export function useX402LowBalanceRules(includeDisabled = true) {
  const { apiClient, authorized } = useAppContext();

  const query = useQuery({
    queryKey: ['x402-low-balance', includeDisabled],
    queryFn: async () => {
      const response = await handleApiCall(
        () => getX402LowBalance({ client: apiClient, query: { includeDisabled } }),
        { errorMessage: 'Failed to fetch low-balance rules' },
      );
      return response?.data?.data?.Rules ?? [];
    },
    enabled: !!apiClient && authorized,
    staleTime: 30000,
  });

  return {
    rules: (query.data ?? []) as X402LowBalanceRule[],
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
