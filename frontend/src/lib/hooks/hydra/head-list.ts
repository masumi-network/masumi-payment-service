/**
 * One of a head's lists, read a page at a time.
 *
 * Errors, transactions, deposits and withdrawals all page the same way: newest
 * first, from an inclusive cursor. The first page loads on open; older pages
 * load only when the reader asks for them. Polling refetches every loaded page,
 * so a row settling on page two is not left stale. That costs one request per
 * page, so the interval stretches with the pages loaded and the request rate
 * stays that of a single page.
 */

import { useCallback, useMemo } from 'react';
import { useInfiniteQuery, type InfiniteData } from '@tanstack/react-query';
import { useAppContext } from '@/lib/contexts/AppContext';
import { handleApiCall } from '@/lib/utils';
import type { ApiEnvelope } from './api';
import { joinInclusivePages, nextInclusiveCursor } from './inclusive-pages';

/** The newest row of a cached head list, or undefined before it loads. */
export function newestRowId<T extends { id: string }>(
  data: InfiniteData<T[]> | undefined,
): string | undefined {
  return data?.pages[0]?.[0]?.id;
}

export function useHydraHeadList<T extends { id: string }>({
  queryKey,
  url,
  field,
  headId,
  pageSize,
  errorMessage,
  staleTime,
  refetchInterval,
}: {
  queryKey: string;
  url: string;
  /** The array's name inside the response envelope. */
  field: string;
  headId: string | null;
  pageSize: number;
  errorMessage: string;
  staleTime: number;
  /** Decided from every loaded row, so it can keep polling until all settle. */
  refetchInterval?: (rows: T[]) => number | false;
}) {
  const { apiClient } = useAppContext();

  const query = useInfiniteQuery({
    queryKey: [queryKey, headId],
    queryFn: async ({ pageParam }) => {
      const response = await handleApiCall(
        () =>
          apiClient.get<{ 200: ApiEnvelope<Record<string, T[]>> }>({
            responseType: 'json',
            url,
            query: { headId, limit: pageSize, cursorId: pageParam },
          }),
        { errorMessage },
      );
      // A failed read is not an empty list. Returning one would end the
      // section's polling and tell the reader there is nothing there.
      const rows = response?.data?.data?.[field];
      if (rows == null) {
        throw new Error(errorMessage);
      }
      return rows;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: T[]) => nextInclusiveCursor(lastPage, pageSize),
    enabled: !!apiClient && headId !== null,
    staleTime,
    refetchInterval: refetchInterval
      ? (current) => {
          const pages = current.state.data?.pages ?? [];
          const interval = refetchInterval(joinInclusivePages(pages));
          return interval === false ? false : interval * Math.max(1, pages.length);
        }
      : undefined,
  });

  const rows = useMemo(() => joinInclusivePages(query.data?.pages ?? []), [query.data]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return {
    rows,
    isLoading: query.isLoading,
    isError: query.isError,
    isFetching: query.isFetching,
    refetch: query.refetch,
    hasMore: hasNextPage,
    isLoadingMore: isFetchingNextPage,
    loadMore,
  };
}
