import { useInfiniteQuery, keepPreviousData } from '@tanstack/react-query';
import { getRegistryA2A, A2aRegistryEntry } from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';
import { handleApiCall } from '@/lib/utils';
import { usePaymentSourceExtendedAll } from '../hooks/usePaymentSourceExtendedAll';
import { useMemo } from 'react';
import { flattenInclusiveCursorPages } from '@/lib/pagination/cursor-pagination';

const PAGE_SIZE = 10;

export function useA2AAgents(params?: {
  filterStatus?: 'Registered' | 'Deregistered' | 'Pending' | 'Failed';
  searchQuery?: string;
}) {
  const { apiClient, network, selectedPaymentSourceId, selectedPaymentSource } = useAppContext();

  const { paymentSources } = usePaymentSourceExtendedAll();

  const hasCurrentNetworkPaymentSources = useMemo(
    () => paymentSources.some((ps) => ps.network === network),
    [paymentSources, network],
  );

  const query = useInfiniteQuery({
    queryKey: [
      'a2a-agents',
      network,
      selectedPaymentSourceId,
      selectedPaymentSource,
      params?.filterStatus,
      params?.searchQuery,
    ],
    queryFn: async ({ pageParam }) => {
      if (!selectedPaymentSource) {
        return { agents: [], nextCursor: undefined };
      }
      if (selectedPaymentSource.network !== network) {
        return { agents: [], nextCursor: undefined };
      }
      const smartContractAddress = selectedPaymentSource?.smartContractAddress;
      const response = await handleApiCall(
        () =>
          getRegistryA2A({
            client: apiClient,
            query: {
              network: network,
              cursorId: pageParam ?? undefined,
              filterSmartContractAddress: smartContractAddress ? smartContractAddress : undefined,
              limit: PAGE_SIZE,
              filterStatus: params?.filterStatus,
              searchQuery: params?.searchQuery || undefined,
            },
          }),
        { errorMessage: 'Failed to load A2A agents' },
      );

      const agents = response?.data?.data?.Assets ?? [];
      const nextCursor =
        agents.length === PAGE_SIZE && agents[agents.length - 1]?.id
          ? agents[agents.length - 1].id
          : undefined;

      return { agents, nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: { nextCursor: string | undefined }) => lastPage.nextCursor,
    enabled: hasCurrentNetworkPaymentSources && !!selectedPaymentSourceId,
    staleTime: 15000,
    placeholderData: keepPreviousData,
  });

  const agents = useMemo(() => {
    const pages = query.data?.pages ?? [];
    const unique = flattenInclusiveCursorPages(
      pages.map((page) => page.agents),
      (agent: A2aRegistryEntry) => agent.id,
    );
    return unique.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [query.data]);

  return {
    agents,
    hasMore: Boolean(query.hasNextPage),
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isRefetching: query.isRefetching,
    isPlaceholderData: query.isPlaceholderData,
    refetch: query.refetch,
    loadMore: query.fetchNextPage,
  };
}
