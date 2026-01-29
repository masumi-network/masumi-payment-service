import { useInfiniteQuery } from '@tanstack/react-query';
import { getRegistry, PaymentSourceExtended, RegistryEntry } from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';
import { handleApiCall } from '@/lib/utils';
import { usePaymentSourceExtendedAll } from '../hooks/usePaymentSourceExtendedAll';
import { useEffect, useMemo, useState } from 'react';

export function useAgents() {
  const { apiClient, network, selectedPaymentSourceId, selectedPaymentSource } = useAppContext();

  const { paymentSources } = usePaymentSourceExtendedAll();

  const [currentNetworkPaymentSources, setCurrentNetworkPaymentSources] = useState<
    PaymentSourceExtended[]
  >([]);
  useEffect(() => {
    setCurrentNetworkPaymentSources(paymentSources.filter((ps) => ps.network === network));
  }, [paymentSources, network]);

  const query = useInfiniteQuery({
    queryKey: ['agents', network, selectedPaymentSourceId, selectedPaymentSource],
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
            },
          }),
        {
          errorMessage: 'Failed to load AI agents',
        },
      );

      const agents = response?.data?.data?.Assets ?? [];
      const nextCursor =
        agents.length === 10 && agents[agents.length - 1]?.id
          ? agents[agents.length - 1].id
          : undefined;

      return {
        agents,
        nextCursor,
      };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: { nextCursor: string | undefined }) => lastPage.nextCursor,
    enabled: currentNetworkPaymentSources.length > 0 && !!selectedPaymentSourceId,
    staleTime: 15000,
  });

  const agents = useMemo(() => {
    const pages = query.data?.pages ?? [];
    const combined = pages.flatMap((page) => page.agents);
    const seen = new Set<string>();
    const unique: RegistryEntry[] = [];

    combined.forEach((tx) => {
      if (tx.id) {
        if (seen.has(tx.id)) return;
        seen.add(tx.id);
      }
      unique.push(tx);
    });

    return unique.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [query.data]);

  return {
    agents,
    hasMore: Boolean(query.hasNextPage),
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isRefetching: query.isRefetching,
    refetch: query.refetch,
    loadMore: query.fetchNextPage,
  };
}
