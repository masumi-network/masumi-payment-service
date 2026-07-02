import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Client } from '@/lib/api/generated/client';
import { useAppContext } from '@/lib/contexts/AppContext';
import { getPaymentSourceExtended, PaymentSourceExtended } from '@/lib/api/generated';
import { handleApiCall } from '@/lib/utils';
import { extractApiErrorMessage } from '@/lib/api-error';
import { appendInclusiveCursorPage } from '@/lib/pagination/cursor-pagination';
import { toast } from 'react-toastify';

type UsePaymentSourceExtendedAllParams = {
  apiClient: Client;
  apiKey: string | null;
};

function usePaymentSourceExtendedAllInternal({
  apiClient,
  apiKey,
}: UsePaymentSourceExtendedAllParams) {
  const query = useQuery<PaymentSourceExtended[]>({
    queryKey: ['payment-sources-all', apiKey],
    queryFn: async () => {
      if (!apiKey) {
        return [];
      }
      const take = 10;
      const aggregated: PaymentSourceExtended[] = [];
      let cursor: string | undefined;

      while (true) {
        // handleApiCall's default failure path returns null, which would make
        // this query RESOLVE with [] — indistinguishable from "no sources
        // exist", so consumers (e.g. AppContext's persisted-source guard)
        // could never tell a failed load from an empty account. Record the
        // failure via onError (throwing from inside onError would re-enter
        // handleApiCall's catch and fire it twice), toast like the old default
        // did, then throw AFTER the call so TanStack Query records it on
        // query.error.
        let loadError: Error | undefined;
        const response = await handleApiCall(
          () =>
            getPaymentSourceExtended({
              client: apiClient,
              query: {
                take,
                cursorId: cursor,
              },
            }),
          {
            onError: (error) => {
              const message = extractApiErrorMessage(error, 'Failed to load payment sources');
              // Dedupe: onError fires once PER attempt (and per focus-refetch). A
              // stable toastId collapses those into a single visible toast per
              // error episode instead of up to retry+1 identical ones.
              toast.error(message, { toastId: 'payment-sources-all-load-error' });
              loadError = error instanceof Error ? error : new Error(message);
            },
          },
        );
        if (loadError) {
          throw loadError;
        }

        const sources = response?.data?.data?.ExtendedPaymentSources ?? [];

        if (sources.length === 0) {
          break;
        }

        const merged = appendInclusiveCursorPage(aggregated, sources, (source) => source.id);
        aggregated.length = 0;
        aggregated.push(...merged);

        if (sources.length < take) {
          break;
        }

        const lastSource = sources[sources.length - 1];

        if (!lastSource?.id || lastSource.id === cursor) {
          break;
        }

        cursor = lastSource.id;
      }

      return aggregated.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    },
    enabled: !!apiClient && !!apiKey,
    staleTime: 25000,
    // The queryFn throws on load failure (so consumers can tell a failed load
    // from an empty account). Cap retries so a failure doesn't fan out into many
    // attempts (each re-running the paginated loop); the toast is deduped anyway.
    retry: 1,
  });

  const paymentSources = useMemo(() => query.data ?? [], [query.data]);
  const preprodPaymentSources = useMemo(
    () => paymentSources.filter((source) => source.network === 'Preprod'),
    [paymentSources],
  );
  const mainnetPaymentSources = useMemo(
    () => paymentSources.filter((source) => source.network === 'Mainnet'),
    [paymentSources],
  );

  return {
    paymentSources,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isRefetching: query.isRefetching,
    refetch: query.refetch,
    error: query.error,
    preprodPaymentSources,
    mainnetPaymentSources,
  };
}

/**
 * Fetch all payment sources (across all pages) for the current network.
 * This eagerly paginates through the payment-source-extended endpoint on first load.
 */
export function usePaymentSourceExtendedAll() {
  const { apiClient, apiKey } = useAppContext();
  return usePaymentSourceExtendedAllInternal({ apiClient, apiKey });
}

export function usePaymentSourceExtendedAllWithParams(params: UsePaymentSourceExtendedAllParams) {
  return usePaymentSourceExtendedAllInternal(params);
}
