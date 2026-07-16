import { useQuery } from '@tanstack/react-query';
import { getFundDistribution, getFundWallet } from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';
import { handleApiCall } from '@/lib/utils';

/**
 * The fund wallet of the selected payment source, or null if none is set up.
 *
 * A 404 is the normal, expected state -- fund distribution is opt-in and most
 * payment sources have no fund wallet -- so it resolves to null rather than
 * surfacing an error toast the way handleApiCall would.
 */
export function useFundWallet() {
  const { apiClient, selectedPaymentSourceId } = useAppContext();

  const query = useQuery({
    queryKey: ['fund-wallet', selectedPaymentSourceId],
    enabled: Boolean(selectedPaymentSourceId),
    queryFn: async () => {
      if (!selectedPaymentSourceId) return null;

      const response = await getFundWallet({
        client: apiClient,
        query: { paymentSourceId: selectedPaymentSourceId },
      });

      // Not-configured is a state, not a failure.
      if (response.error) return null;
      return response.data?.data ?? null;
    },
  });

  return {
    fundWallet: query.data ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    refetch: query.refetch,
  };
}

/** Recent distribution requests for a fund wallet, newest first. */
export function useFundDistributions(
  fundWalletId: string | null | undefined,
  options?: { enabled?: boolean },
) {
  const { apiClient } = useAppContext();

  const query = useQuery({
    queryKey: ['fund-distributions', fundWalletId],
    enabled: Boolean(fundWalletId) && options?.enabled !== false,
    queryFn: async () => {
      if (!fundWalletId) return [];

      const response = await handleApiCall(
        () =>
          getFundDistribution({
            client: apiClient,
            query: { fundWalletId, take: 20 },
          }),
        { errorMessage: 'Failed to load fund distributions' },
      );

      return response?.data?.data?.FundDistributions ?? [];
    },
  });

  return {
    distributions: query.data ?? [],
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    refetch: query.refetch,
  };
}
