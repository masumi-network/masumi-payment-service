import { useCallback, useMemo } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useAppContext, type NetworkType } from '@/lib/contexts/AppContext';
import { isTestnetEnv } from '@/lib/x402-rail';
import {
  getX402Budgets,
  getX402LowBalance,
  getX402Networks,
  getX402NetworksAvailable,
  getX402Payments,
  getX402Wallets,
  X402Budget,
  X402LowBalanceRule,
  X402AvailableNetwork,
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

export function useX402Networks(options?: {
  silentErrors?: boolean;
  network?: NetworkType;
  allEnvironments?: boolean;
}) {
  const { apiClient, authorized, network: activeNetwork } = useAppContext();
  const silentErrors = options?.silentErrors ?? false;
  // Always scope chains to an environment, enforced at the query level: testnet chains
  // belong to Preprod, mainnet chains to Mainnet. Defaults to the active top-selector env;
  // callers that own their env (e.g. the setup wizard) can pass it explicitly.
  const network = options?.network ?? activeNetwork;
  const isTestnet = isTestnetEnv(network);
  // Some callers span both environments at once. API keys carry a NetworkLimit that can
  // include both Cardano networks, so their ChainIdLimit must be choosable from every
  // EVM chain regardless of the active top-selector env. Omitting isTestnet returns all.
  const allEnvironments = options?.allEnvironments ?? false;

  const query = useQuery({
    // Keyed by silentErrors so the silent (selector) and toasting (tab) consumers do
    // not share one cache entry and race on which onError handler runs, and by env so
    // switching the top selector refetches the right environment's chains.
    queryKey: ['x402-networks', silentErrors, allEnvironments ? 'all' : isTestnet],
    queryFn: async () => {
      const response = await handleApiCall(
        () =>
          getX402Networks({
            client: apiClient,
            query: allEnvironments ? {} : { isTestnet: isTestnet ? 'true' : 'false' },
          }),
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

export function useAvailableX402Networks(options?: {
  silentErrors?: boolean;
  network?: NetworkType;
  allEnvironments?: boolean;
}) {
  const { apiClient, authorized, network: activeNetwork } = useAppContext();
  const silentErrors = options?.silentErrors ?? false;
  const network = options?.network ?? activeNetwork;
  const isTestnet = isTestnetEnv(network);
  const allEnvironments = options?.allEnvironments ?? false;

  const query = useQuery({
    // Keep this under the shared x402-networks prefix so chain mutations invalidate
    // both the admin projection and this pay-authenticated safe projection.
    queryKey: ['x402-networks', 'available', silentErrors, allEnvironments ? 'all' : isTestnet],
    queryFn: async () => {
      const response = await handleApiCall(
        () =>
          getX402NetworksAvailable({
            client: apiClient,
            query: allEnvironments ? {} : { isTestnet: isTestnet ? 'true' : 'false' },
          }),
        silentErrors ? { onError: () => {} } : { errorMessage: 'Failed to fetch available chains' },
      );
      return response?.data?.data?.Networks ?? [];
    },
    enabled: !!apiClient && authorized,
    staleTime: 30000,
  });

  return {
    networks: (query.data ?? []) as X402AvailableNetwork[],
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
export function useX402Wallets(enabled = true, type?: X402Wallet['type'], networkId?: string) {
  const { apiClient, authorized } = useAppContext();

  const query = useQuery({
    queryKey: ['x402-wallets', 'all', type ?? 'any', networkId ?? 'any'],
    queryFn: async () => {
      let items: X402Wallet[] = [];
      let cursor: string | undefined;
      while (true) {
        const response = await handleApiCall(
          () =>
            getX402Wallets({
              client: apiClient,
              query: { take: PAGE_SIZE, cursorId: cursor, type, networkId },
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
        () =>
          getX402LowBalance({
            client: apiClient,
            query: { includeDisabled: includeDisabled ? 'true' : 'false' },
          }),
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
  /** Coarse side switch: buy = outbound payments, sell = inbound (verify + settle). */
  side?: 'buy' | 'sell';
  caip2Network?: string;
  /** Stale ambiguous inbound settles awaiting operator reconciliation. */
  needsManualAction?: boolean;
};

export function useX402PaymentAttempts(filters: X402PaymentFilters = {}) {
  const { apiClient, authorized } = useAppContext();

  const query = useInfiniteQuery({
    queryKey: [
      'x402-payments',
      filters.status ?? null,
      filters.side ?? null,
      filters.caip2Network ?? null,
      filters.needsManualAction ?? false,
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
              side: filters.side,
              caip2Network: filters.caip2Network,
              filterNeedsManualAction: filters.needsManualAction ? ('true' as const) : undefined,
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
