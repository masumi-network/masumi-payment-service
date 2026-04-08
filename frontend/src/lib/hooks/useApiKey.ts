import { useCallback, useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useAppContext } from '@/lib/contexts/AppContext';
import { getApiKey, ApiKey } from '@/lib/api/generated';
import { handleApiCall } from '@/lib/utils';
import { flattenInclusiveCursorPages } from '@/lib/pagination/cursor-pagination';

const PAGE_SIZE = 20;

export function useApiKeys() {
  const { apiClient } = useAppContext();

  const query = useInfiniteQuery({
    queryKey: ['api-keys'],
    queryFn: async ({ pageParam }) => {
      const cursorId = pageParam ?? undefined;

      const response = await handleApiCall(
        () =>
          getApiKey({
            client: apiClient,
            query: {
              cursorId,
              take: PAGE_SIZE,
            },
          }),
        {
          onError: (error: unknown) => {
            console.error('Failed to fetch API keys:', error);
          },
          errorMessage: 'Failed to fetch API keys',
        },
      );

      const apiKeys = response?.data?.data?.ApiKeys ?? [];
      const hasMore = apiKeys.length === PAGE_SIZE;
      const nextCursor = hasMore ? (apiKeys[apiKeys.length - 1]?.id ?? undefined) : undefined;

      return {
        apiKeys,
        nextCursor,
        hasMore,
      };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined,
    enabled: !!apiClient,
    staleTime: 15000,
  });

  const {
    data,
    isLoading: queryIsLoading,
    isRefetching,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    refetch,
  } = query;

  const apiKeys = useMemo(() => {
    const pages = data?.pages ?? [];
    return flattenInclusiveCursorPages(
      pages.map((page) => page.apiKeys),
      (key: ApiKey) => key.id,
    );
  }, [data]);

  const isLoading = queryIsLoading || isRefetching;
  const hasMore = Boolean(hasNextPage);

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  return {
    apiKeys,
    allApiKeys: apiKeys,
    isLoading,
    hasMore,
    loadMore,
    isFetchingNextPage,
    refetch,
    isRefetching,
  };
}

export const useApiKey = useApiKeys;
