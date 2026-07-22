import { useCallback, useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  deleteTxSyncQuarantine,
  getTxSyncQuarantine,
  postTxSyncQuarantineRetry,
  type TxSyncQuarantineEntry,
} from '@/lib/api/generated';
import { useAppContext, type NetworkType } from '@/lib/contexts/AppContext';
import { useApiMutation } from '@/lib/hooks/useApiMutation';

export const QUARANTINE_STATUSES = [
  'Unresolved',
  'Pending',
  'NeedsOperator',
  'Resolved',
  'All',
] as const;
export type QuarantineStatus = (typeof QUARANTINE_STATUSES)[number];

/** Sentinel for the network filter: the query param is omitted entirely. */
export const ALL_NETWORKS = 'AllNetworks';
export type QuarantineNetworkFilter = NetworkType | typeof ALL_NETWORKS;

export type QuarantineEntry = TxSyncQuarantineEntry;

export const QUARANTINE_QUERY_KEY = 'tx-sync-quarantine';

const QUARANTINE_PAGE_SIZE = 25;

export function useTxSyncQuarantine(params: {
  status: QuarantineStatus;
  network: QuarantineNetworkFilter;
}) {
  const { apiClient, authorized } = useAppContext();

  const query = useInfiniteQuery({
    queryKey: [QUARANTINE_QUERY_KEY, params.status, params.network],
    queryFn: async ({ pageParam }) => {
      const response = await getTxSyncQuarantine({
        client: apiClient,
        query: {
          status: params.status,
          network: params.network === ALL_NETWORKS ? undefined : params.network,
          take: QUARANTINE_PAGE_SIZE,
          cursorId: pageParam as string | undefined,
        },
      });

      if (response.error) {
        throw response.error;
      }

      const entries = response.data?.data?.Quarantine;
      if (entries == null) {
        throw new Error('The quarantine request returned no data');
      }

      return entries;
    },
    initialPageParam: undefined as string | undefined,
    // The cursor row is returned again on the next page (server-side cursors are
    // inclusive here), so a full page is the only "there may be more" signal and
    // the flattened list is deduped by id below.
    getNextPageParam: (lastPage: QuarantineEntry[]) =>
      lastPage.length === QUARANTINE_PAGE_SIZE ? lastPage[lastPage.length - 1]?.id : undefined,
    enabled: !!apiClient && authorized,
    staleTime: 15000,
  });

  const entries = useMemo(() => {
    const seen = new Set<string>();
    return (query.data?.pages ?? []).flat().filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return true;
    });
  }, [query.data]);

  const loadMore = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) {
      void query.fetchNextPage();
    }
  }, [query]);

  return {
    entries,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    isFetching: query.isFetching,
    isFetchingNextPage: query.isFetchingNextPage,
    hasMore: Boolean(query.hasNextPage),
    loadMore,
    refetch: query.refetch,
  };
}

/** Re-queues an entry for immediate retry. The reconciler performs the retry. */
export function useRetryQuarantineEntry() {
  const { apiClient } = useAppContext();

  return useApiMutation({
    mutationFn: (id: string) => postTxSyncQuarantineRetry({ client: apiClient, body: { id } }),
    invalidateKeys: [[QUARANTINE_QUERY_KEY]],
    errorMessage: 'Failed to queue the retry',
    successMessage: 'Queued for immediate retry',
  });
}

/**
 * Removes an entry WITHOUT applying its transaction — the database stays behind
 * the chain for whatever that transaction would have changed. Callers must say
 * so before confirming.
 */
export function useDeleteQuarantineEntry() {
  const { apiClient } = useAppContext();

  return useApiMutation({
    mutationFn: (id: string) => deleteTxSyncQuarantine({ client: apiClient, body: { id } }),
    invalidateKeys: [[QUARANTINE_QUERY_KEY]],
    errorMessage: 'Failed to delete the quarantine entry',
    successMessage: 'Quarantine entry deleted. The transaction was not applied',
  });
}
