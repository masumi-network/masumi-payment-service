import { useCallback, useState } from 'react';
import Head from 'next/head';
import { MainLayout } from '@/components/layout/MainLayout';
import { AnimatedPage } from '@/components/ui/animated-page';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Pagination } from '@/components/ui/pagination';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { RefreshButton } from '@/components/RefreshButton';
import { QuarantineTable } from '@/components/tx-sync-quarantine/QuarantineTable';
import { TransactionTableSkeleton } from '@/components/skeletons/TransactionTableSkeleton';
import { useAppContext } from '@/lib/contexts/AppContext';
import {
  ALL_NETWORKS,
  useDeleteQuarantineEntry,
  useRetryQuarantineEntry,
  useTxSyncQuarantine,
  type QuarantineEntry,
  type QuarantineNetworkFilter,
  type QuarantineStatus,
} from '@/lib/hooks/useTxSyncQuarantine';

const STATUS_OPTIONS: { value: QuarantineStatus; label: string }[] = [
  { value: 'Pending', label: 'Pending' },
  { value: 'NeedsOperator', label: 'Needs operator' },
  { value: 'Resolved', label: 'Resolved' },
  { value: 'All', label: 'All' },
];

const EMPTY_COPY: Record<QuarantineStatus, { title: string; description: string }> = {
  Pending: {
    title: 'Nothing waiting to be retried',
    description: 'Every transaction the scanner has seen has been applied.',
  },
  NeedsOperator: {
    title: 'Nothing needs an operator',
    description: 'No entry has run out of retries or hit a non-retryable failure.',
  },
  Resolved: {
    title: 'No resolved entries',
    description: 'Entries that were applied or discarded are kept here for audit.',
  },
  All: {
    title: 'The quarantine queue is empty',
    description: 'No transaction has failed to apply on this network.',
  },
};

export default function TxSyncQuarantinePage() {
  const { network } = useAppContext();
  const [status, setStatus] = useState<QuarantineStatus>('Pending');
  const [networkFilter, setNetworkFilter] = useState<QuarantineNetworkFilter>(network);
  const [entryToDelete, setEntryToDelete] = useState<QuarantineEntry | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const { entries, isLoading, isFetching, isFetchingNextPage, hasMore, loadMore, refetch } =
    useTxSyncQuarantine({ status, network: networkFilter });
  const retryEntry = useRetryQuarantineEntry();
  const deleteEntry = useDeleteQuarantineEntry();

  const isInitialLoading = isLoading && entries.length === 0;

  const handleRetry = useCallback(
    async (entry: QuarantineEntry) => {
      setRetryingId(entry.id);
      try {
        await retryEntry.mutateAsync(entry.id);
      } catch {
        // useApiMutation already surfaced the failure as a toast.
      } finally {
        setRetryingId(null);
      }
    },
    [retryEntry],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!entryToDelete) return;
    try {
      await deleteEntry.mutateAsync(entryToDelete.id);
      setEntryToDelete(null);
    } catch {
      // Keep the dialog open on failure; the toast explains why.
    }
  }, [deleteEntry, entryToDelete]);

  return (
    <MainLayout>
      <Head>
        <title>Sync Quarantine | Admin Interface</title>
      </Head>
      <AnimatedPage>
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Sync Quarantine</h1>
              <p className="text-sm text-muted-foreground max-w-3xl">
                Transactions the chain scanner could not apply. The sync checkpoint has already
                moved past them, so anything still pending here is chain state the database has not
                caught up with — the affected request is running on stale information until the
                transaction is applied.
              </p>
            </div>
            <RefreshButton onRefresh={() => void refetch()} isRefreshing={isFetching} />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Select value={status} onValueChange={(value) => setStatus(value as QuarantineStatus)}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={networkFilter}
              onValueChange={(value) => setNetworkFilter(value as QuarantineNetworkFilter)}
            >
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Network" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Preprod">Preprod</SelectItem>
                <SelectItem value="Mainnet">Mainnet</SelectItem>
                <SelectItem value={ALL_NETWORKS}>All networks</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {isInitialLoading ? (
            <div className="border rounded-lg overflow-x-auto">
              <table className="w-full">
                <tbody>
                  <TransactionTableSkeleton rows={5} />
                </tbody>
              </table>
            </div>
          ) : (
            <QuarantineTable
              entries={entries}
              isLoading={isFetching && entries.length > 0}
              onRetry={handleRetry}
              onDelete={setEntryToDelete}
              retryingId={retryingId}
              emptyTitle={EMPTY_COPY[status].title}
              emptyDescription={EMPTY_COPY[status].description}
            />
          )}

          <div className="flex flex-col gap-4 items-center">
            {!isInitialLoading && (
              <Pagination hasMore={hasMore} isLoading={isFetchingNextPage} onLoadMore={loadMore} />
            )}
          </div>
        </div>

        <ConfirmDialog
          open={!!entryToDelete}
          onClose={() => setEntryToDelete(null)}
          title="Delete quarantine entry"
          description={
            entryToDelete
              ? `Deleting this entry does NOT apply transaction ${entryToDelete.txHash}. The database stays behind the chain for whatever that transaction would have changed, and nothing will retry it again.\n\nOnly delete entries that are genuinely irrelevant — a transaction belonging to another system, or one you have already repaired by hand.`
              : ''
          }
          onConfirm={handleConfirmDelete}
          isLoading={deleteEntry.isPending}
          requireConfirmation
        />
      </AnimatedPage>
    </MainLayout>
  );
}
