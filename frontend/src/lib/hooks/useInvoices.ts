import { useMemo, useCallback } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useAppContext } from '@/lib/contexts/AppContext';
import { getInvoiceMonthly } from '@/lib/api/generated';
import { handleApiCall } from '@/lib/utils';

export type InvoiceSummary = NonNullable<
  Awaited<ReturnType<typeof getInvoiceMonthly>>['data']
>['data']['Invoices'][number];

export function useInvoices(month: string, includeAllRevisions: boolean) {
  const { apiClient } = useAppContext();

  const query = useInfiniteQuery({
    queryKey: ['invoices', month, includeAllRevisions],
    queryFn: async ({ pageParam }) => {
      const result = await handleApiCall(
        () =>
          getInvoiceMonthly({
            client: apiClient,
            query: {
              month,
              cursorId: pageParam ?? undefined,
              limit: 20,
              includeAllRevisions,
            },
          }),
        { errorMessage: 'Failed to fetch invoices' },
      );

      const invoices = result?.data?.data?.Invoices ?? [];
      const hasMore = invoices.length === 20;
      const nextCursor = hasMore ? invoices[invoices.length - 1]?.id : undefined;

      return { invoices, nextCursor, hasMore };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined,
    enabled: !!apiClient && !!month,
    staleTime: 15000,
  });

  const invoices = useMemo(() => {
    const pages = query.data?.pages ?? [];
    return pages.flatMap((page) => page.invoices);
  }, [query.data]);

  const isLoading = query.isLoading || query.isRefetching;
  const hasMore = Boolean(query.hasNextPage);
  const isFetchingNextPage = query.isFetchingNextPage;
  const refetch = query.refetch;

  const loadMore = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) {
      query.fetchNextPage();
    }
  }, [query]);

  return {
    invoices,
    isLoading,
    hasMore,
    loadMore,
    isFetchingNextPage,
    refetch,
  };
}
