import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Client } from '@hey-api/client-axios';
import { useAppContext } from '@/lib/contexts/AppContext';
import {
  getPaymentSourceExtended,
  PaymentSourceExtended,
} from '@/lib/api/generated';
import { handleApiCall } from '@/lib/utils';

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
            errorMessage: 'Failed to load payment sources',
          },
        );

        const sources = response?.data?.data?.ExtendedPaymentSources ?? [];

        if (sources.length === 0) {
          break;
        }

        aggregated.push(...sources);

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
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    },
    enabled: !!apiClient && !!apiKey,
    staleTime: 25000,
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

export function usePaymentSourceExtendedAllWithParams(
  params: UsePaymentSourceExtendedAllParams,
) {
  return usePaymentSourceExtendedAllInternal(params);
}
