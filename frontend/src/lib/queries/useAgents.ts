import { useInfiniteQuery } from '@tanstack/react-query';
import { getRegistry } from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';
import { handleApiCall } from '@/lib/utils';

export function useAgents() {
  const { apiClient, state, selectedPaymentSourceId } = useAppContext();

  const selectedPaymentSource = state.paymentSources?.find(
    (ps) => ps.id === selectedPaymentSourceId,
  );

  const smartContractAddress =
    selectedPaymentSource?.smartContractAddress ?? null;

  const query = useInfiniteQuery({
    queryKey: [
      'agents',
      state.network,
      selectedPaymentSourceId,
      smartContractAddress,
    ],
    queryFn: async ({ pageParam }) => {
      const response = await handleApiCall(
        () =>
          getRegistry({
            client: apiClient,
            query: {
              network: state.network,
              cursorId: pageParam ?? undefined,
              filterSmartContractAddress: smartContractAddress
                ? smartContractAddress
                : undefined,
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
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled:
      !!state.paymentSources &&
      state.paymentSources.length > 0 &&
      !!selectedPaymentSourceId,
    staleTime: 0,
  });

  const agents = query.data?.pages.flatMap((page) => page.agents) ?? [];

  return {
    ...query,
    agents,
    hasMore: Boolean(query.hasNextPage),
  };
}
