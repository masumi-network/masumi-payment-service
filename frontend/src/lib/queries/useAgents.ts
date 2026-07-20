import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { getRegistry, GetRegistryData, RegistryEntry } from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';
import { usePaymentSourceExtendedAll } from '../hooks/usePaymentSourceExtendedAll';
import { useMemo } from 'react';
import { flattenInclusiveCursorPages } from '@/lib/pagination/cursor-pagination';
import { extractApiErrorMessage } from '@/lib/api-error';
import { toast } from 'react-toastify';
import {
  AgentListFilters,
  buildAgentListQuery,
  collectAllAgentPages,
  resolveAgentListSource,
} from './agent-query';

const PAGE_SIZE = 10;
const ALL_AGENTS_PAGE_SIZE = 100;

async function fetchAgentPage(
  apiClient: ReturnType<typeof useAppContext>['apiClient'],
  query: GetRegistryData['query'],
): Promise<RegistryEntry[]> {
  try {
    const response = await getRegistry({ client: apiClient, query });
    if (response.error) {
      throw response.error;
    }
    return response.data?.data?.Assets ?? [];
  } catch (error) {
    const message = extractApiErrorMessage(error, 'Failed to load AI agents');
    toast.error(message, { toastId: 'agents-load-error' });
    throw error instanceof Error ? error : new Error(message);
  }
}

function sortAgents(agents: RegistryEntry[]): RegistryEntry[] {
  return [...agents].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
}

export function useAgents(params?: AgentListFilters) {
  const { apiClient, network, selectedPaymentSourceId, selectedPaymentSource } = useAppContext();

  const { paymentSources, isLoading: isLoadingPaymentSources } = usePaymentSourceExtendedAll();

  const hasCurrentNetworkPaymentSources = useMemo(
    () => paymentSources.some((ps) => ps.network === network),
    [paymentSources, network],
  );
  const source = resolveAgentListSource(selectedPaymentSourceId, selectedPaymentSource, network);

  const query = useInfiniteQuery({
    queryKey: [
      'agents',
      'pages',
      network,
      selectedPaymentSourceId,
      source?.paymentSourceType,
      params?.filterStatus,
      params?.searchQuery,
    ],
    queryFn: async ({ pageParam }) => {
      if (!source) return { agents: [], nextCursor: undefined };

      const agents = await fetchAgentPage(
        apiClient,
        buildAgentListQuery(source, params ?? {}, PAGE_SIZE, pageParam),
      );
      const nextCursor =
        agents.length === PAGE_SIZE &&
        agents[agents.length - 1]?.id &&
        agents[agents.length - 1]?.id !== pageParam
          ? agents[agents.length - 1].id
          : undefined;

      return {
        agents,
        nextCursor,
      };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: { nextCursor: string | undefined }) => lastPage.nextCursor,
    enabled: hasCurrentNetworkPaymentSources && source != null,
    staleTime: 15000,
    retry: 1,
  });

  const agents = useMemo(() => {
    const pages = query.data?.pages ?? [];
    const unique = flattenInclusiveCursorPages(
      pages.map((page) => page.agents),
      (agent: RegistryEntry) => agent.id,
    );

    return sortAgents(unique);
  }, [query.data]);

  const isSourceResolving = hasCurrentNetworkPaymentSources && source == null;

  return {
    agents,
    hasMore: Boolean(query.hasNextPage),
    isLoading: isLoadingPaymentSources || isSourceResolving || query.isLoading,
    isFetching: query.isFetching,
    isRefetching: query.isRefetching,
    refetch: query.refetch,
    loadMore: query.fetchNextPage,
  };
}

/**
 * Complete, source-scoped agent list for testing tools. Unlike the dashboard's
 * on-demand pagination, this query does not expose a partial dropdown: it walks
 * every inclusive-cursor page and only publishes the result when all pages load.
 */
export function useAllAgents(
  params?: AgentListFilters & {
    enabled?: boolean;
  },
) {
  const { apiClient, network, selectedPaymentSourceId, selectedPaymentSource } = useAppContext();
  const { paymentSources, isLoading: isLoadingPaymentSources } = usePaymentSourceExtendedAll();
  const callerEnabled = params?.enabled ?? true;
  const filters = {
    filterStatus: params?.filterStatus,
    searchQuery: params?.searchQuery,
  };

  const hasCurrentNetworkPaymentSources = useMemo(
    () => paymentSources.some((paymentSource) => paymentSource.network === network),
    [paymentSources, network],
  );
  const source = resolveAgentListSource(selectedPaymentSourceId, selectedPaymentSource, network);

  const query = useQuery({
    queryKey: [
      'agents',
      'all',
      network,
      selectedPaymentSourceId,
      source?.paymentSourceType,
      filters.filterStatus,
      filters.searchQuery,
    ],
    queryFn: async () => {
      if (!source) return [];

      const agents = await collectAllAgentPages(
        (cursor) =>
          fetchAgentPage(
            apiClient,
            buildAgentListQuery(source, filters, ALL_AGENTS_PAGE_SIZE, cursor),
          ),
        ALL_AGENTS_PAGE_SIZE,
      );

      return sortAgents(agents);
    },
    enabled: callerEnabled && hasCurrentNetworkPaymentSources && source != null,
    // Reopening a developer tool must re-check registration state immediately;
    // otherwise a just-confirmed agent can stay absent behind a fresh cache entry.
    staleTime: 0,
    retry: 1,
  });

  const isSourceResolving = callerEnabled && hasCurrentNetworkPaymentSources && source == null;

  return {
    agents: query.data ?? [],
    // Initial load only (no cached data yet). Background refetches — which
    // staleTime 0 triggers on every reopen/refocus — must NOT flip this back
    // to true, or agent pickers disable mid-interaction despite having a
    // complete cached option list to offer.
    isLoading: callerEnabled && (isLoadingPaymentSources || isSourceResolving || query.isLoading),
    isFetching: query.isFetching,
    // Background refetch while cached data is displayed.
    isRefetching: callerEnabled && query.isFetching && !query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
