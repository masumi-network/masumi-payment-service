import { useInfiniteQuery, keepPreviousData } from '@tanstack/react-query';
import { getRegistry, RegistryEntry } from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';
import { handleApiCall } from '@/lib/utils';
import { usePaymentSourceExtendedAll } from '../hooks/usePaymentSourceExtendedAll';
import { useMemo } from 'react';
import { flattenInclusiveCursorPages } from '@/lib/pagination/cursor-pagination';

const PAGE_SIZE = 10;

export function useAgents(params?: {
  filterStatus?: 'Registered' | 'Deregistered' | 'Pending' | 'Failed';
  searchQuery?: string;
}) {
  const { apiClient, network, selectedPaymentSourceId, selectedPaymentSource } = useAppContext();

  const { paymentSources, isLoading: isLoadingPaymentSources } = usePaymentSourceExtendedAll();

  const hasCurrentNetworkPaymentSources = useMemo(
    () => paymentSources.some((ps) => ps.network === network),
    [paymentSources, network],
  );

  // The query cannot run until the selected payment source is known, and agents
  // are listed per source.
  const isEnabled = hasCurrentNetworkPaymentSources && !!selectedPaymentSourceId;

  const query = useInfiniteQuery({
    // Key on the source id only — NOT the whole selectedPaymentSource object.
    // The object carries volatile sync fields (lastCheckedAt, syncInProgress, …)
    // that change on every payment-sources refetch, which would discard all
    // loaded pages, and it embeds the rpcProviderApiKey secret in the key hash.
    queryKey: [
      'agents',
      network,
      selectedPaymentSourceId,
      params?.filterStatus,
      params?.searchQuery,
    ],
    queryFn: async ({ pageParam }) => {
      if (!selectedPaymentSource) {
        return {
          agents: [],
          nextCursor: undefined,
        };
      }
      if (selectedPaymentSource.network !== network) {
        return {
          agents: [],
          nextCursor: undefined,
        };
      }
      const smartContractAddress = selectedPaymentSource?.smartContractAddress;
      const response = await handleApiCall(
        () =>
          getRegistry({
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
        {
          errorMessage: 'Failed to load AI agents',
        },
      );

      const agents = response?.data?.data?.Assets ?? [];
      const nextCursor =
        agents.length === PAGE_SIZE && agents[agents.length - 1]?.id
          ? agents[agents.length - 1].id
          : undefined;

      return {
        agents,
        nextCursor,
      };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: { nextCursor: string | undefined }) => lastPage.nextCursor,
    enabled: isEnabled,
    staleTime: 15000,
    placeholderData: keepPreviousData,
  });

  const agents = useMemo(() => {
    const pages = query.data?.pages ?? [];
    const unique = flattenInclusiveCursorPages(
      pages.map((page) => page.agents),
      (agent: RegistryEntry) => agent.id,
    );

    return unique.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [query.data]);

  return {
    agents,
    hasMore: Boolean(query.hasNextPage),
    // A disabled query is not "loading" by TanStack's definition: it is pending
    // and not fetching, so `isLoading` is false before the payment source has
    // resolved. Callers read that as "asked and got nothing" and told the
    // operator there were no agents, when nothing had been asked yet. Waiting on
    // the source is reported as loading, because to the operator it is.
    isLoading: query.isLoading || (!isEnabled && isLoadingPaymentSources),
    isFetching: query.isFetching,
    isRefetching: query.isRefetching,
    isPlaceholderData: query.isPlaceholderData,
    refetch: query.refetch,
    loadMore: query.fetchNextPage,
  };
}
