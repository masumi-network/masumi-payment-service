import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getWebhooks } from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';
import { handleApiCall } from '@/lib/utils';
import type { WebhookRecord } from '@/lib/webhooks';

export function useWebhooks() {
  const { apiClient, selectedPaymentSourceId } = useAppContext();

  const query = useQuery<WebhookRecord[]>({
    queryKey: ['webhooks', selectedPaymentSourceId],
    queryFn: async () => {
      if (!selectedPaymentSourceId) {
        return [];
      }

      const response = await handleApiCall(
        () =>
          getWebhooks({
            client: apiClient,
            query: {
              paymentSourceId: selectedPaymentSourceId,
              limit: 50,
            },
          }),
        {
          onError: (error: unknown) => {
            console.error('Failed to fetch webhooks:', error);
          },
          errorMessage: 'Failed to load webhooks',
        },
      );

      return response?.data?.data?.Webhooks ?? [];
    },
    enabled: !!apiClient && !!selectedPaymentSourceId,
    staleTime: 15000,
  });

  const webhooks = useMemo(() => query.data ?? [], [query.data]);

  return {
    ...query,
    webhooks,
    isLoading: query.isLoading,
  };
}
