import { useMemo, useCallback } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useAppContext } from '@/lib/contexts/AppContext';
import { getInvoiceMonthlyUninvoiced } from '@/lib/api/generated';
import { handleApiCall } from '@/lib/utils';

export type UninvoicedPayment = NonNullable<
  Awaited<ReturnType<typeof getInvoiceMonthlyUninvoiced>>['data']
>['data']['UninvoicedPayments'][number];

export function useUninvoicedPayments(month: string, buyerWalletVkey?: string) {
  const { apiClient } = useAppContext();

  const query = useInfiniteQuery({
    queryKey: ['uninvoiced-payments', month, buyerWalletVkey],
    queryFn: async ({ pageParam }) => {
      const result = await handleApiCall(
        () =>
          getInvoiceMonthlyUninvoiced({
            client: apiClient,
            query: {
              month,
              buyerWalletVkey: buyerWalletVkey || undefined,
              cursorId: pageParam ?? undefined,
              limit: 50,
            },
          }),
        { errorMessage: 'Failed to fetch uninvoiced payments' },
      );

      const payments = result?.data?.data?.UninvoicedPayments ?? [];
      const hasMore = payments.length === 50;
      const nextCursor = hasMore ? payments[payments.length - 1]?.id : undefined;

      return { payments, nextCursor, hasMore };
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
    hasMore,
    loadMore,
    isFetchingNextPage,
    refetch,
  };
}
