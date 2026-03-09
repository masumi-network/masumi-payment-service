import { useMemo, useCallback } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useAppContext } from '@/lib/contexts/AppContext';
import { getInvoiceMonthlyMissing } from '@/lib/api/generated';
import { extractApiErrorMessage } from '@/lib/api-error';
import { buildExclusiveCursorPage } from '@/lib/pagination/cursor-pagination';

export type UninvoicedPayment = NonNullable<
  Awaited<ReturnType<typeof getInvoiceMonthlyMissing>>['data']
>['data']['UninvoicedPayments'][number];

export function useUninvoicedPayments(month: string, buyerWalletVkey?: string) {
  const { apiClient } = useAppContext();

  const query = useInfiniteQuery({
    queryKey: ['uninvoiced-payments', month, buyerWalletVkey],
    queryFn: async ({ pageParam }) => {
      const limit = 50;
      const result = await getInvoiceMonthlyMissing({
        client: apiClient,
        query: {
          month,
          buyerWalletVkey: buyerWalletVkey || undefined,
          cursorId: pageParam ?? undefined,
          limit: limit + 1,
        },
      });

      if (result.error) {
        throw new Error(
          extractApiErrorMessage(result.error, 'Failed to fetch uninvoiced payments'),
        );
      }

      const allPayments = result.data?.data?.UninvoicedPayments ?? [];
      const page = buildExclusiveCursorPage(allPayments, limit, (payment) => payment.id);

      return {
        payments: page.items,
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
      };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined,
    enabled: !!apiClient && !!month,
    staleTime: 15000,
  });

  const payments = useMemo(() => {
    const pages = query.data?.pages ?? [];
    return pages.flatMap((page) => page.payments);
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
    payments,
    isLoading,
    isError: query.isError,
    error: query.error,
    hasMore,
    loadMore,
    isFetchingNextPage,
    refetch,
  };
}
