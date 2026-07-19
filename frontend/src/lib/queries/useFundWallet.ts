import { useQuery } from '@tanstack/react-query';
import { getFundDistribution, getFundWallet } from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';
import { extractApiErrorMessage } from '@/lib/api-error';
import { getOwnValue, isObject } from '@/lib/object-properties';

/**
 * HTTP status of a failed generated-client call.
 *
 * The client is axios-backed and resolves with the AxiosError rather than
 * throwing, so the status lives at `.response.status`. Read defensively: the
 * union with the success arm makes direct access unsound, and a transport
 * failure has no response at all.
 */
function getResponseStatus(value: unknown): number | undefined {
  if (!isObject(value)) return undefined;
  const response = getOwnValue(value, 'response');
  if (!isObject(response)) return undefined;
  const status = getOwnValue(response, 'status');
  return typeof status === 'number' ? status : undefined;
}

/**
 * The fund wallets of the selected payment source (there may be several, for
 * redundancy / capacity), or an empty list if none is set up.
 *
 * An empty list is the normal, expected state -- fund distribution is opt-in and
 * most payment sources have no fund wallet -- so it resolves to [] rather than
 * surfacing an error toast. Any real error must propagate: "no fund wallet" and
 * "couldn't tell" look identical to the caller otherwise, and they lead to
 * opposite UI (the create form invites the operator to paste a seed phrase).
 */
export function useFundWallet(options?: { enabled?: boolean }) {
  const { apiClient, selectedPaymentSourceId } = useAppContext();

  const query = useQuery({
    queryKey: ['fund-wallet', selectedPaymentSourceId],
    enabled: Boolean(selectedPaymentSourceId) && options?.enabled !== false,
    queryFn: async () => {
      if (!selectedPaymentSourceId) return [];

      const response = await getFundWallet({
        client: apiClient,
        query: { paymentSourceId: selectedPaymentSourceId },
      });

      if (response.error) {
        // The list endpoint returns [] (200) for an unconfigured source, but keep
        // the 404 fallback for older responses.
        if (getResponseStatus(response) === 404) return [];
        throw new Error(extractApiErrorMessage(response.error, 'Failed to load fund wallets'));
      }
      return response.data?.data?.FundWallets ?? [];
    },
  });

  return {
    fundWallets: query.data ?? [],
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    // Distinguishes "no fund wallet" from "couldn't load it" for the caller.
    error: query.error,
    refetch: query.refetch,
  };
}

/** Recent distribution requests for a fund wallet or payment source, newest first. */
export function useFundDistributions(
  filters: {
    fundWalletId?: string | null;
    paymentSourceId?: string | null;
  },
  options?: { enabled?: boolean; refetchInterval?: number },
) {
  const { apiClient } = useAppContext();
  const hasFilter = Boolean(filters.fundWalletId || filters.paymentSourceId);

  const query = useQuery({
    queryKey: ['fund-distributions', filters],
    enabled: hasFilter && options?.enabled !== false,
    refetchInterval: options?.refetchInterval,
    queryFn: async () => {
      if (!hasFilter) return [];

      // Errors must PROPAGATE, mirroring useFundWallet above. Swallowing them
      // (toast + empty array) marked the query successful, so a transient
      // failure rendered an authoritative "No top-ups yet" that never retried —
      // hiding Failed rows the operator needed to see.
      const response = await getFundDistribution({
        client: apiClient,
        query: {
          ...(filters.fundWalletId ? { fundWalletId: filters.fundWalletId } : {}),
          ...(filters.paymentSourceId ? { paymentSourceId: filters.paymentSourceId } : {}),
          take: 20,
        },
      });
      if (response.error) {
        throw new Error(
          extractApiErrorMessage(response.error, 'Failed to load fund distributions'),
        );
      }

      return response.data?.data?.FundDistributions ?? [];
    },
  });

  return {
    distributions: query.data ?? [],
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    refetch: query.refetch,
  };
}
