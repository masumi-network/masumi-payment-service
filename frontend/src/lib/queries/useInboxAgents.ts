import { useInfiniteQuery, keepPreviousData } from '@tanstack/react-query';
import { getInboxAgents, RegistryInboxEntry } from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';
import { handleApiCall } from '@/lib/utils';
import { usePaymentSourceExtendedAll } from '../hooks/usePaymentSourceExtendedAll';
import { useMemo } from 'react';
import { flattenInclusiveCursorPages } from '@/lib/pagination/cursor-pagination';

const PAGE_SIZE = 10;

export function useInboxAgents(params?: {
  filterStatus?: 'Registered' | 'Deregistered' | 'Pending' | 'Failed';
  searchQuery?: string;
}) {
  const { apiClient, network, selectedPaymentSourceId, selectedPaymentSource } = useAppContext();
  const { paymentSources } = usePaymentSourceExtendedAll();

  const hasCurrentNetworkPaymentSources = useMemo(
    () => paymentSources.some((paymentSource) => paymentSource.network === network),
    [paymentSources, network],
  );

  const query = useInfiniteQuery({
    // Key on the source id only — NOT the whole selectedPaymentSource object.
    // The object carries volatile sync fields (lastCheckedAt, syncInProgress, …)
    // that change on every payment-sources refetch, which would discard all
    // loaded pages, and it embeds the rpcProviderApiKey secret in the key hash.
    queryKey: [
      'inbox-agents',
      network,
      selectedPaymentSourceId,
      params?.filterStatus,
      params?.searchQuery,
    ],
    queryFn: async ({ pageParam }) => {
      if (!selectedPaymentSource) {
        return {
          inboxAgents: [],
          nextCursor: undefined,
        };
      }

      if (selectedPaymentSource.network !== network) {
        return {
          inboxAgents: [],
          nextCursor: undefined,
        };
      }

      const smartContractAddress = selectedPaymentSource.smartContractAddress;
      const response = await handleApiCall(
        () =>
          getInboxAgents({
            client: apiClient,
            query: {
              network,
              cursorId: pageParam ?? undefined,
              filterSmartContractAddress: smartContractAddress || undefined,
              limit: PAGE_SIZE,
              filterStatus: params?.filterStatus,
              searchQuery: params?.searchQuery || undefined,
            },
          }),
        {
          errorMessage: 'Failed to load inbox agents',
        },
      );

      const inboxAgents = response?.data?.data?.Assets ?? [];
      const nextCursor =
        inboxAgents.length === PAGE_SIZE && inboxAgents[inboxAgents.length - 1]?.id
          ? inboxAgents[inboxAgents.length - 1].id
          : undefined;

      return {
        inboxAgents,
        nextCursor,
      };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: { nextCursor: string | undefined }) => lastPage.nextCursor,
    enabled: hasCurrentNetworkPaymentSources && !!selectedPaymentSourceId,
    staleTime: 15000,
    placeholderData: keepPreviousData,
  });

  const inboxAgents = useMemo(() => {
    const pages = query.data?.pages ?? [];
    const unique = flattenInclusiveCursorPages(
      pages.map((page) => page.inboxAgents),
      (inboxAgent: RegistryInboxEntry) => inboxAgent.id,
    );

    return unique.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [query.data]);

  return {
    inboxAgents,
    hasMore: Boolean(query.hasNextPage),
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isRefetching: query.isRefetching,
    isPlaceholderData: query.isPlaceholderData,
    refetch: query.refetch,
    loadMore: query.fetchNextPage,
  };
}
