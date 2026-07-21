import { useQuery } from '@tanstack/react-query';
import { useAppContext, type NetworkType } from '@/lib/contexts/AppContext';
import { getRailReadiness, type RailReadiness } from '@/lib/api/generated';
import { handleApiCall } from '@/lib/utils';
import { railOf } from '@/lib/rail-readiness';

/**
 * Backend-owned answer to "is this rail set up?".
 *
 * Setup surfaces used to derive this client-side from the chain, wallet and
 * budget lists, which drifted from each other and from the server. Reading it
 * from one endpoint keeps a step from showing complete when the backend would
 * still refuse the payment.
 */
export function useRailReadiness(options?: { network?: NetworkType; silentErrors?: boolean }) {
  const { apiClient, authorized, network: activeNetwork } = useAppContext();
  const network = options?.network ?? activeNetwork;
  const silentErrors = options?.silentErrors ?? false;

  const query = useQuery({
    queryKey: ['rail-readiness', network, silentErrors],
    queryFn: async () => {
      const response = await handleApiCall(
        () => getRailReadiness({ client: apiClient, query: { network } }),
        silentErrors
          ? { onError: () => {} }
          : { errorMessage: 'Failed to fetch payment rail readiness' },
      );
      return response?.data?.data ?? null;
    },
    enabled: !!apiClient && authorized,
    staleTime: 30000,
  });

  const readiness: RailReadiness | null = query.data ?? null;

  return {
    readiness,
    cardano: railOf(readiness, 'CardanoV2'),
    x402: railOf(readiness, 'X402'),
    // The query is disabled until authorized, and a disabled query reports
    // isLoading false with no data — which would read as "nothing configured".
    // Treat the pre-auth window as loading so callers never act on that.
    isLoading: !authorized || query.isLoading,
    refetch: query.refetch,
  };
}
