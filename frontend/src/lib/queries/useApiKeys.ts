import { useQuery } from '@tanstack/react-query';
import { getApiKey } from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';
import { handleApiCall } from '@/lib/utils';

export function useApiKeys(cursorToken?: string | null) {
  const { apiClient, state } = useAppContext();

  return useQuery({
    queryKey: ['apiKeys', state.network, cursorToken],
    queryFn: async () => {
      const response = await handleApiCall(
        () =>
          getApiKey({
            client: apiClient,
            query: {
              limit: 10,
              cursorToken: cursorToken || undefined,
            },
          }),
        {
          errorMessage: 'Failed to fetch API keys',
        },
      );

      if (!response?.data?.data?.ApiKeys) {
        return { apiKeys: [], hasMore: false };
      }
      const apiKeys = response.data.data.ApiKeys;
      return {
        apiKeys,
        hasMore: apiKeys.length === 10,
      };
    },
    staleTime: 0,
  });
}
