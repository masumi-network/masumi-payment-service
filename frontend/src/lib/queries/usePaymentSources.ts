import { useQuery } from '@tanstack/react-query';
import { getPaymentSourceExtended } from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';
import { handleApiCall } from '@/lib/utils';

export function usePaymentSources(cursorId?: string | null) {
  const { apiClient, state } = useAppContext();

  return useQuery({
    queryKey: ['paymentSources', state.network, cursorId],
    queryFn: async () => {
      const response = await handleApiCall(
        () =>
          getPaymentSourceExtended({
            client: apiClient,
            query: {
              take: 10,
              cursorId: cursorId || undefined,
            },
          }),
        {
          errorMessage: 'Failed to load payment sources',
        },
      );

      if (!response?.data?.data?.ExtendedPaymentSources) {
        return { paymentSources: [], hasMore: false };
      }

      const allSources = response.data.data.ExtendedPaymentSources;
      const filteredSources = allSources.filter(
        (source) => source.network === state.network,
      );

      return {
        paymentSources: filteredSources,
        hasMore: allSources.length === 10,
      };
    },
    staleTime: 0,
  });
}
