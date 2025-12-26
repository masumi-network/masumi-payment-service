import { useQuery } from '@tanstack/react-query';
import { getRegistry } from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';
import { handleApiCall } from '@/lib/utils';

export function useAgents(cursorId?: string | null) {
  const { apiClient, state, selectedPaymentSourceId } = useAppContext();

  const selectedPaymentSource = state.paymentSources?.find(
    (ps) => ps.id === selectedPaymentSourceId,
  );
  const smartContractAddress =
    selectedPaymentSource?.smartContractAddress ?? null;

  return useQuery({
    queryKey: [
      'agents',
      state.network,
      selectedPaymentSourceId,
      smartContractAddress,
      cursorId,
    ],
    queryFn: async () => {
      const response = await handleApiCall(
        () =>
          getRegistry({
            client: apiClient,
            query: {
              network: state.network,
              cursorId: cursorId || undefined,
              filterSmartContractAddress: smartContractAddress
                ? smartContractAddress
                : undefined,
            },
          }),
        {
          errorMessage: 'Failed to load AI agents',
        },
      );

      if (!response?.data?.data?.Assets) {
        return { agents: [], hasMore: false };
      }
      const agents = response.data.data.Assets;
      return {
        agents,
        hasMore: agents.length === 10,
      };
    },
    enabled:
      !!state.paymentSources &&
      state.paymentSources.length > 0 &&
      !!selectedPaymentSourceId,
    staleTime: 60 * 1000, // 60 seconds
  });
}
