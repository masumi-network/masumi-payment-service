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
 * The fund wallet of the selected payment source, or null if none is set up.
 *
 * A 404 is the normal, expected state -- fund distribution is opt-in and most
 * payment sources have no fund wallet -- so it resolves to null rather than
 * surfacing an error toast the way handleApiCall would. Any OTHER error is a
 * real failure and must propagate: "no fund wallet" and "couldn't tell" look
 * identical to the caller otherwise, and they lead to opposite UI.
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

      // ONLY 404 means "not configured". Swallowing every error would render the
      // create form for a source that already has a funded treasury whenever the
      // API hiccups — inviting the operator to paste a seed phrase into a form
      // that can only 409.
      if (response.error) {
        if (getResponseStatus(response) === 404) return null;
        throw new Error(extractApiErrorMessage(response.error, 'Failed to load fund wallet'));
      }
      return response.data?.data ?? null;
    },
  });

  return {
    fundWallet: query.data ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    // Distinguishes "no fund wallet" from "couldn't load it" for the caller.
    error: query.error,
    refetch: query.refetch,
  };
}

/** Recent distribution requests for a fund wallet, newest first. */
export function useFundDistributions(
  fundWalletId: string | null | undefined,
  options?: { enabled?: boolean; refetchInterval?: number },
) {
  const { apiClient } = useAppContext();

  const query = useQuery({
    queryKey: ['fund-distributions', fundWalletId],
    enabled: Boolean(fundWalletId) && options?.enabled !== false,
    refetchInterval: options?.refetchInterval,
    queryFn: async () => {
      if (!fundWalletId) return [];

      // Errors must PROPAGATE, mirroring useFundWallet above. Swallowing them
      // (toast + empty array) marked the query successful, so a transient
      // failure rendered an authoritative "No top-ups yet" that never retried —
      // hiding Failed rows the operator needed to see.
      const response = await getFundDistribution({
        client: apiClient,
        query: { fundWalletId, take: 20 },
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
