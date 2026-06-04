import { useInfiniteQuery, keepPreviousData } from '@tanstack/react-query';
import { getSimpleApi, SimpleApiListing } from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';
import { handleApiCall } from '@/lib/utils';
import { useMemo } from 'react';
import { flattenInclusiveCursorPages } from '@/lib/pagination/cursor-pagination';

const PAGE_SIZE = 12;

export type SimpleApiStatusFilter = 'Online' | 'Offline' | 'Invalid' | 'Deregistered';

export function useSimpleApiListings(params?: {
  filterStatus?: SimpleApiStatusFilter;
  searchQuery?: string;
}) {
  const { apiClient, network } = useAppContext();

  const query = useInfiniteQuery({
    queryKey: ['simple-api-listings', network, params?.filterStatus, params?.searchQuery],
    queryFn: async ({ pageParam }) => {
      const response = await handleApiCall(
        () =>
          getSimpleApi({
            client: apiClient,
            query: {
              network,
              cursorId: pageParam ?? undefined,
              limit: PAGE_SIZE,
              filterStatus: params?.filterStatus,
              searchQuery: params?.searchQuery || undefined,
            },
          }),
        { errorMessage: 'Failed to load Simple API listings' },
      );

      const listings = response?.data?.data?.SimpleApiListings ?? [];
      const nextCursor =
        listings.length === PAGE_SIZE && listings[listings.length - 1]?.id
          ? listings[listings.length - 1].id
          : undefined;

      return { listings, nextCursor };
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage: { nextCursor: string | undefined }) => lastPage.nextCursor,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });

  const listings = useMemo(() => {
    const pages = query.data?.pages ?? [];
    return flattenInclusiveCursorPages(
      pages.map((page) => page.listings),
      (listing: SimpleApiListing) => listing.id,
    );
  }, [query.data]);

  return {
    listings,
    hasMore: Boolean(query.hasNextPage),
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isPlaceholderData: query.isPlaceholderData,
    refetch: query.refetch,
    loadMore: query.fetchNextPage,
  };
}
