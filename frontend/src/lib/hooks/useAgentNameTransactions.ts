import { useCallback, useMemo } from 'react';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useAppContext } from '@/lib/contexts/AppContext';
import { dedupeTransactions } from '@/lib/hooks/useTransactions.helpers';
import type { OnChainStateFilter } from '@/lib/hooks/useTransactions';
import {
  resolveAgentIdentifiersByName,
  shouldSearchTransactionsByAgentName,
} from '@/lib/transactions/agent-name-search';
import {
  fetchTransactionsByAgentIdentifiersPage,
  hasMoreAgentIdentifierPages,
  initCursors,
  type AgentNameTransactionsPageParam,
} from '@/lib/transactions/fetch-transactions-by-agent-identifiers';

type AgentNameTransactionQueryParams = {
  filterOnChainState?: OnChainStateFilter;
  searchQuery?: string;
  transactionType?: 'payment' | 'purchase';
};

type AgentNameTransactionsPage = {
  transactions: ReturnType<typeof dedupeTransactions>;
  hasMore: boolean;
  nextPageParam?: AgentNameTransactionsPageParam;
  nameByIdentifier: Map<string, string>;
};

export function useAgentNameTransactions(
  params?: AgentNameTransactionQueryParams,
  options?: { enabled?: boolean },
) {
  const { apiClient, network } = useAppContext();
  const isCandidate =
    options?.enabled !== false &&
    !!apiClient &&
    shouldSearchTransactionsByAgentName(params?.searchQuery);
  const searchQuery = params?.searchQuery?.trim() ?? '';

  const resolutionQuery = useQuery({
    queryKey: ['agent-name-resolution', network, searchQuery],
    queryFn: () => resolveAgentIdentifiersByName(apiClient, network, searchQuery),
    enabled: isCandidate,
    staleTime: 15000,
  });

  const identifiers = resolutionQuery.data?.identifiers ?? [];
  const nameByIdentifier = resolutionQuery.data?.nameByIdentifier ?? new Map<string, string>();
  const hasMatches = identifiers.length > 0;
  const shouldFallbackToStandard =
    isCandidate && resolutionQuery.isFetched && !resolutionQuery.isLoading && !hasMatches;

  const skipPurchases = params?.transactionType === 'payment';
  const skipPayments = params?.transactionType === 'purchase';

  const query = useInfiniteQuery({
    queryKey: [
      'transactions',
      'agent-name',
      network,
      params?.filterOnChainState,
      searchQuery,
      params?.transactionType,
      identifiers,
    ],
    queryFn: async ({ pageParam }): Promise<AgentNameTransactionsPage> => {
      const cursorState = pageParam as AgentNameTransactionsPageParam | undefined;
      const cursors = cursorState?.cursors ?? initCursors(identifiers);

      const { page, cursors: nextCursors } = await fetchTransactionsByAgentIdentifiersPage({
        apiClient,
        network,
        identifiers,
        cursors,
        filterOnChainState: params?.filterOnChainState,
        skipPayments,
        skipPurchases,
      });

      const hasMore = hasMoreAgentIdentifierPages(nextCursors);

      return {
        transactions: page.transactions,
        hasMore,
        nextPageParam: hasMore
          ? { identifiers, cursors: nextCursors, nameByIdentifier }
          : undefined,
        nameByIdentifier,
      };
    },
    initialPageParam: undefined as AgentNameTransactionsPageParam | undefined,
    getNextPageParam: (lastPage) => lastPage.nextPageParam,
    refetchInterval: 25000,
    enabled: isCandidate && hasMatches,
    staleTime: 15000,
    placeholderData: keepPreviousData,
  });

  const transactions = useMemo(() => {
    const pages = query.data?.pages ?? [];
    return dedupeTransactions(pages.flatMap((page) => page.transactions));
  }, [query.data]);

  const loadMore = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) {
      void query.fetchNextPage();
    }
  }, [query]);

  const isResolvingAgents = isCandidate && resolutionQuery.isLoading;
  const isLoading =
    isResolvingAgents || (hasMatches && (query.isLoading || (query.isFetching && !query.data)));

  return {
    transactions,
    nameByIdentifier,
    isLoading,
    hasMore: Boolean(query.hasNextPage),
    loadMore,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetching: query.isFetching || resolutionQuery.isFetching,
    refetch: query.refetch,
    isRefetching: query.isRefetching,
    isPlaceholderData: query.isPlaceholderData,
    isCandidate,
    shouldFallbackToStandard,
    isResolvingAgents,
  };
}
