import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';

import { MASUMI_PAYMENTS_DOCS_URL } from '@/lib/masumi-links';
import { cn } from '@/lib/utils';
import { MainLayout } from '@/components/layout/MainLayout';
import { RefreshButton } from '@/components/RefreshButton';
import Head from 'next/head';
import { useAppContext } from '@/lib/contexts/AppContext';
import { TransactionTableSkeleton } from '@/components/skeletons/TransactionTableSkeleton';
import { HorizontalScrollArea } from '@/components/ui/horizontal-scroll-area';
import { tableActionsHeadCompactClass } from '@/components/ui/table-actions-column';
import { CheckCheck, FlaskConical } from 'lucide-react';
import { Tabs } from '@/components/ui/tabs';
import { Pagination } from '@/components/ui/pagination';
import TransactionDetailsDialog from '@/components/transactions/TransactionDetailsDialog';
import { DownloadDetailsDialog } from '@/components/transactions/DownloadDetailsDialog';
import { Download } from 'lucide-react';
import { useTransactions, OnChainStateFilter } from '@/lib/hooks/useTransactions';
import { AnimatedPage } from '@/components/ui/animated-page';
import { SearchInput } from '@/components/ui/search-input';
import { EmptyState } from '@/components/ui/empty-state';
import { useDebouncedValue } from '@/lib/hooks/useDebouncedValue';
import { filterTransactionsClientSide } from '@/lib/client-search/transaction-search';
import Link from 'next/link';
import {
  isTransactionErrorRecoverable,
  isTransactionNeedingAction,
} from '@/components/transactions/transaction-format.helpers';
import { TransactionTableRow } from '@/components/transactions/TransactionTableRow';
import { useAcknowledgeNeedsAction } from '@/lib/hooks/useAcknowledgeNeedsAction';
import { BulkActionBar } from '@/components/ui/bulk-action-bar';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { TableSelectAllCheckbox } from '@/components/ui/table-select-checkbox';
import {
  TransactionFilters,
  EMPTY_FILTERS,
  type TransactionFilterState,
} from '@/components/transactions/TransactionFilters';
import { buildTransactionReportViewDefaults } from '@/components/transactions/download-details.helpers';
import { useBulkClearTransactionErrors } from '@/lib/hooks/useBulkClearTransactionErrors';
import { toast } from 'react-toastify';
import { useResync } from '@/lib/hooks/useResync';
import { useTransactionTabCounts } from '@/lib/hooks/useTransactionTabCounts';
import { useTableSelection } from '@/lib/hooks/useTableSelection';

type Transaction = ReturnType<typeof useTransactions>['transactions'][number];

export default function Transactions() {
  const { apiClient, selectedPaymentSourceId, network, capabilities } = useAppContext();
  const resync = useResync();

  const [activeTab, setActiveTab] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [filters, setFilters] = useState<TransactionFilterState>(EMPTY_FILTERS);
  const reportViewDefaults = useMemo(
    () => buildTransactionReportViewDefaults(activeTab, filters, searchQuery.trim().length > 0),
    [activeTab, filters, searchQuery],
  );
  const debouncedSearchQuery = useDebouncedValue(searchQuery);
  // Error recovery posts to /payment|purchase/error-state-recovery (pay-authenticated).
  const canRecoverErrors = capabilities.canPay;

  const filterParams = useMemo(() => {
    const params: {
      filterOnChainState?: OnChainStateFilter;
      filterNeedsManualAction?: boolean;
      searchQuery?: string;
      transactionType?: 'payment' | 'purchase';
    } = {};

    if (activeTab === 'Payments') params.transactionType = 'payment';
    else if (activeTab === 'Purchases') params.transactionType = 'purchase';
    else if (activeTab === 'Refund Requests') params.filterOnChainState = 'RefundRequested';
    else if (activeTab === 'Disputes') params.filterOnChainState = 'Disputed';
    else if (activeTab === 'Needs Action') params.filterNeedsManualAction = true;

    // Explicit filters override the tab defaults (errorType is client-side only).
    if (filters.type) params.transactionType = filters.type;
    if (filters.status) params.filterOnChainState = filters.status;
    if (filters.needsAction) params.filterNeedsManualAction = true;

    // Trimmed to match the backend's own normalizeSearchQuery, so a stray
    // trailing space cannot create a second react-query key for a request
    // that returns identical rows.
    const trimmedSearchQuery = debouncedSearchQuery.trim();
    if (trimmedSearchQuery) params.searchQuery = trimmedSearchQuery;

    return params;
  }, [activeTab, debouncedSearchQuery, filters]);

  const {
    transactions,
    isLoading,
    hasMore,
    loadMore,
    refetch: refetchTransactions,
    isFetchingNextPage,
    isFetching: isFetchingTransactions,
    isPlaceholderData,
  } = useTransactions(filterParams, { trackVisit: false });

  // Unfiltered instance for the "new transactions" watermark (shares the layout's
  // cache); only this instance updates localStorage.
  const { markAllAsRead } = useTransactions();
  const { data: tabCounts, refetch: refetchTabCounts } = useTransactionTabCounts();

  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);
  const [showDownloadDialog, setShowDownloadDialog] = useState(false);
  const { recoverErrors, isRecovering } = useBulkClearTransactionErrors();
  const [bulkRecoveryMode, setBulkRecoveryMode] = useState<'clear' | 'retry' | null>(null);
  const [bulkConfirmMode, setBulkConfirmMode] = useState<'clear' | 'retry' | null>(null);
  const { acknowledge, isAcknowledging } = useAcknowledgeNeedsAction();
  // Rows for the acknowledge confirm dialog. Kept after close so the text does
  // not change while the dialog fades out.
  const [acknowledgeTargets, setAcknowledgeTargets] = useState<Transaction[]>([]);
  const [isAcknowledgeOpen, setIsAcknowledgeOpen] = useState(false);
  const openAcknowledge = useCallback((targets: Transaction[]) => {
    setAcknowledgeTargets(targets);
    setIsAcknowledgeOpen(true);
  }, []);
  const isBusy = isRecovering || isAcknowledging;
  // Acknowledge is offered only here: every row in this view is unacknowledged,
  // because the backend filter leaves acknowledged rows out.
  // Placeholder rows belong to the previous view and may hold acknowledged rows.
  const isNeedsActionView =
    (activeTab === 'Needs Action' || filters.needsAction) && !isPlaceholderData;
  const isLoadingMore = isFetchingNextPage;
  const isInitialLoading = isLoading && !transactions.length;

  const tabs = useMemo(
    () => [
      { name: 'All', count: null },
      { name: 'Payments', count: null },
      { name: 'Purchases', count: null },
      {
        name: 'Refund Requests',
        count: tabCounts?.refundRequests || null,
        variant: 'alert' as const,
      },
      {
        name: 'Disputes',
        count: tabCounts?.disputes || null,
        variant: 'alert' as const,
      },
      {
        name: 'Needs Action',
        count: tabCounts?.needsAction || null,
        variant: 'alert' as const,
      },
    ],
    [tabCounts],
  );

  // Dedup only — server handles filtering
  const filteredTransactions = useMemo(() => {
    const seenIds = new Set<string>();
    return transactions.filter((tx) => {
      if (!tx.id) return true;
      if (seenIds.has(tx.id)) return false;
      seenIds.add(tx.id);
      return true;
    });
  }, [transactions]);

  // True whenever server-authoritative results haven't arrived yet:
  // either the debounce hasn't fired, or the server fetch is still in-flight with stale data.
  const isSearchPending =
    searchQuery !== debouncedSearchQuery || (isFetchingTransactions && isPlaceholderData);

  // Client-side filter for instant feedback while server results are pending.
  // Mirrors the backend Prisma OR filter in src/utils/shared/queries.ts
  // (buildTransactionSearchFilter) to avoid items appearing/disappearing when the
  // server responds. Matching MORE fields here than the backend is the bug this
  // guards against: those rows show during the debounce and vanish on response.
  // Deliberately absent, matching the backend: network, paymentSourceType and
  // transaction type — the query is already scoped to one network and source
  // type, so matching them would make any substring of those return everything.
  // The backend lower-cases and trims the query and matches every column
  // case-insensitively, so a single lower-cased `query` mirrors it exactly.
  const displayTransactions = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    if (!query || (query === debouncedSearchQuery.toLowerCase().trim() && !isPlaceholderData))
      return filteredTransactions;

    return filterTransactionsClientSide(filteredTransactions, searchQuery);
  }, [filteredTransactions, searchQuery, debouncedSearchQuery, isPlaceholderData]);

  const refreshTransactions = useCallback(() => {
    void refetchTransactions?.();
    void refetchTabCounts();
  }, [refetchTransactions, refetchTabCounts]);

  // Error type has no server-side param, so narrow it client-side. Pagination-limited.
  const visibleTransactions = useMemo(() => {
    if (!filters.errorType) return displayTransactions;
    return displayTransactions.filter((tx) => tx.NextAction?.errorType === filters.errorType);
  }, [displayTransactions, filters.errorType]);

  const selectableIds = useMemo(
    () => visibleTransactions.map((tx) => tx.id).filter((id): id is string => Boolean(id)),
    [visibleTransactions],
  );

  const {
    selectedIds,
    selectedCount,
    clearSelection,
    allSelected,
    someSelected,
    toggleAll,
    toggleRow,
    isSelected,
    setSelectionToIds,
  } = useTableSelection(selectableIds);

  const recoverableSelectedTransactions = useMemo(
    () =>
      visibleTransactions.filter(
        (tx) => tx.id && selectedIds.has(tx.id) && isTransactionErrorRecoverable(tx, network),
      ),
    [visibleTransactions, selectedIds, network],
  );
  const recoverableSelectedCount = recoverableSelectedTransactions.length;

  const acknowledgeableVisibleTransactions = useMemo(
    () => (isNeedsActionView ? visibleTransactions.filter(isTransactionNeedingAction) : []),
    [isNeedsActionView, visibleTransactions],
  );
  const acknowledgeableSelectedTransactions = useMemo(
    () => acknowledgeableVisibleTransactions.filter((tx) => tx.id && selectedIds.has(tx.id)),
    [acknowledgeableVisibleTransactions, selectedIds],
  );
  const acknowledgeableSelectedCount = acknowledgeableSelectedTransactions.length;

  const handleAcknowledge = useCallback(
    async (targets: Transaction[]) => {
      const { acknowledged, failed } = await acknowledge(targets);
      const skipped = targets.length - acknowledged - failed;
      if (acknowledged > 0) {
        toast.success(
          `Acknowledged ${acknowledged} transaction${acknowledged === 1 ? '' : 's'}. They no longer show in Needs Action.`,
        );
      }
      if (failed > 0) {
        toast.error(`Failed to acknowledge ${failed} transaction${failed === 1 ? '' : 's'}`);
      }
      if (skipped > 0) {
        toast.info(
          `${skipped} transaction${skipped === 1 ? ' was' : 's were'} not acknowledged: changed since this page loaded, already out of Needs Action, or created by another API key.`,
        );
      }
      clearSelection();
      refreshTransactions();
    },
    [acknowledge, clearSelection, refreshTransactions],
  );

  const handleBulkRecoverErrors = useCallback(
    async (retryPreviousAction: boolean) => {
      if (recoverableSelectedTransactions.length === 0) return;

      const selected = recoverableSelectedTransactions;

      setBulkRecoveryMode(retryPreviousAction ? 'retry' : 'clear');
      try {
        const { succeeded, failed, failedIds } = await recoverErrors(selected, retryPreviousAction);
        if (succeeded > 0) {
          toast.success(
            retryPreviousAction
              ? `Queued ${succeeded} failed action${succeeded === 1 ? '' : 's'} for retry`
              : `Cleared error state for ${succeeded} transaction${succeeded === 1 ? '' : 's'}`,
          );
        }
        if (failed > 0) {
          toast.error(
            retryPreviousAction
              ? `Failed to retry ${failed} transaction${failed === 1 ? '' : 's'}`
              : `Failed to clear ${failed} transaction${failed === 1 ? '' : 's'}`,
          );
        }

        // Keep only the failed rows selected so the user can retry them.
        setSelectionToIds(failedIds);
        await resync('transactions');
        refreshTransactions();
      } finally {
        setBulkRecoveryMode(null);
      }
    },
    [
      recoverableSelectedTransactions,
      recoverErrors,
      refreshTransactions,
      resync,
      setSelectionToIds,
    ],
  );

  const handleRowRecoverErrors = useCallback(
    async (transaction: Transaction, retryPreviousAction: boolean) => {
      if (!transaction.id) return;

      setBulkRecoveryMode(retryPreviousAction ? 'retry' : 'clear');
      try {
        const { succeeded, failed } = await recoverErrors([transaction], retryPreviousAction);
        if (succeeded > 0) {
          toast.success(
            retryPreviousAction
              ? 'Queued failed action for retry'
              : 'Cleared error state for transaction',
          );
        }
        if (failed > 0) {
          toast.error(
            retryPreviousAction ? 'Failed to retry transaction' : 'Failed to clear error state',
          );
        }
        await resync('transactions');
        refreshTransactions();
      } finally {
        setBulkRecoveryMode(null);
      }
    },
    [recoverErrors, refreshTransactions, resync],
  );

  // When context changes, clear "new transactions" badge via the hook (single source of truth for localStorage)
  const markAllAsReadRef = useRef(markAllAsRead);
  useEffect(() => {
    markAllAsReadRef.current = markAllAsRead;
  }, [markAllAsRead]);
  useEffect(() => {
    markAllAsReadRef.current();
  }, [network, apiClient, selectedPaymentSourceId]);

  const handleLoadMore = useCallback(() => {
    if (hasMore && !isLoadingMore) {
      loadMore();
    }
  }, [hasMore, isLoadingMore, loadMore]);

  return (
    <MainLayout>
      <Head>
        <title>Transactions | Admin Interface</title>
      </Head>
      <AnimatedPage>
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Transactions</h1>
              <p className="text-sm text-muted-foreground">
                View and manage your transaction history.{' '}
                <a
                  href={MASUMI_PAYMENTS_DOCS_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  Learn more
                </a>
              </p>
            </div>
            <div className="flex items-center gap-2">
              <RefreshButton
                onRefresh={() => refreshTransactions()}
                isRefreshing={isFetchingTransactions}
              />
              <Button
                onClick={() => setShowDownloadDialog(true)}
                variant="outline"
                className="flex items-center gap-2 btn-hover-lift"
              >
                <Download className="h-4 w-4" />
                Export report
              </Button>
              {/* Developers > Testing creates real payments/purchases via
                  pay-authenticated endpoints, and the tab is hidden for
                  read-only keys, so this shortcut would dead-end. */}
              {capabilities.canPay && (
                <Link href="/developers">
                  <Button className="flex items-center gap-2 btn-hover-lift">
                    <FlaskConical className="h-4 w-4" />
                    Test transaction
                  </Button>
                </Link>
              )}
            </div>
          </div>

          <Tabs
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={(tab) => {
              setActiveTab(tab);
              clearSelection();
            }}
          />

          <div className="flex items-center gap-2">
            <div className="flex-1">
              <SearchInput
                value={searchQuery}
                onChange={(value) => {
                  setSearchQuery(value);
                  clearSelection();
                }}
                placeholder="Search by agent name, ID, hash, wallet, status, amount..."
                className="max-w-xs"
                isLoading={isSearchPending && !!searchQuery}
              />
            </div>
            <TransactionFilters
              filters={filters}
              onChange={(next) => {
                setFilters(next);
                clearSelection();
              }}
            />
            {canRecoverErrors && acknowledgeableVisibleTransactions.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="flex items-center gap-2"
                onClick={() => openAcknowledge(acknowledgeableVisibleTransactions)}
                disabled={isBusy}
              >
                <CheckCheck className="h-4 w-4" />
                {`Acknowledge all visible (${acknowledgeableVisibleTransactions.length})`}
              </Button>
            )}
          </div>

          <BulkActionBar selectedCount={selectedCount} onClear={clearSelection} disabled={isBusy}>
            {!canRecoverErrors ? (
              <span className="max-w-md text-right text-sm text-muted-foreground">
                Bulk recovery requires an API key with pay access.
              </span>
            ) : recoverableSelectedCount === 0 && acknowledgeableSelectedCount === 0 ? (
              <span className="max-w-md text-right text-sm text-muted-foreground">
                {
                  'No bulk actions for this selection. Pick rows with an error, or open the Needs Action tab.'
                }
              </span>
            ) : (
              <>
                {recoverableSelectedCount > 0 && recoverableSelectedCount < selectedCount ? (
                  <span className="text-xs text-muted-foreground">
                    {recoverableSelectedCount} of {selectedCount} can be recovered
                  </span>
                ) : null}
                {acknowledgeableSelectedCount > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-border bg-background shadow-xs hover:bg-background"
                    onClick={() => openAcknowledge(acknowledgeableSelectedTransactions)}
                    disabled={isBusy}
                  >
                    {`Acknowledge (${acknowledgeableSelectedCount})`}
                  </Button>
                )}
                {recoverableSelectedCount > 0 && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-border bg-background shadow-xs hover:bg-background"
                      onClick={() => setBulkConfirmMode('clear')}
                      disabled={isBusy}
                    >
                      {bulkRecoveryMode === 'clear'
                        ? 'Clearing error states...'
                        : `Clear error state (${recoverableSelectedCount})`}
                    </Button>
                    <Button size="sm" onClick={() => setBulkConfirmMode('retry')} disabled={isBusy}>
                      {bulkRecoveryMode === 'retry'
                        ? 'Queueing retries...'
                        : `Retry failed action (${recoverableSelectedCount})`}
                    </Button>
                  </>
                )}
              </>
            )}
          </BulkActionBar>

          <HorizontalScrollArea className="border rounded-lg">
            <table
              className={cn(
                'w-full transition-opacity duration-150',
                isSearchPending && 'opacity-70',
              )}
            >
              <thead className="table-header-surface">
                <tr className="border-b">
                  <th className="w-10 p-4 pl-6">
                    <TableSelectAllCheckbox
                      allSelected={allSelected}
                      someSelected={someSelected}
                      onToggleAll={toggleAll}
                      disabled={selectableIds.length === 0}
                      aria-label="Select all transactions on this page"
                    />
                  </th>
                  <th className="p-4 text-left text-sm font-medium text-muted-foreground">Type</th>
                  <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                    Transaction Hash
                  </th>
                  <th className="p-4 text-left text-sm font-medium text-muted-foreground">Agent</th>
                  <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                    Amount
                  </th>
                  <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                    Source
                  </th>
                  <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                    Status
                  </th>
                  <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                    Unlock Time
                  </th>
                  <th className="p-4 text-left text-sm font-medium text-muted-foreground">Date</th>
                  <th className={tableActionsHeadCompactClass}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {isInitialLoading || (visibleTransactions.length === 0 && isSearchPending) ? (
                  <TransactionTableSkeleton rows={5} withSelectionColumn />
                ) : visibleTransactions.length === 0 ? (
                  <tr>
                    <td colSpan={10}>
                      <EmptyState
                        icon={searchQuery ? 'search' : 'inbox'}
                        title={
                          searchQuery
                            ? 'No transactions found matching your search'
                            : 'No transactions found'
                        }
                        description={
                          searchQuery
                            ? 'Try adjusting your search terms'
                            : 'Transactions will appear here once payments are made.'
                        }
                        action={
                          !searchQuery && capabilities.canPay ? (
                            <Link
                              href="/developers"
                              className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
                            >
                              <FlaskConical className="h-3.5 w-3.5" />
                              Create a test transaction
                            </Link>
                          ) : undefined
                        }
                      />
                    </td>
                  </tr>
                ) : (
                  visibleTransactions.map((transaction, index) => (
                    <TransactionTableRow
                      key={transaction.id}
                      transaction={transaction}
                      index={index}
                      network={network}
                      isSelected={Boolean(transaction.id && isSelected(transaction.id))}
                      canRecover={canRecoverErrors}
                      isRecovering={isBusy}
                      onToggleSelected={() => transaction.id && toggleRow(transaction.id)}
                      onOpen={() => setSelectedTransaction(transaction)}
                      onClearError={() => void handleRowRecoverErrors(transaction, false)}
                      onRetryFailedAction={() => void handleRowRecoverErrors(transaction, true)}
                      onAcknowledge={
                        isNeedsActionView ? () => openAcknowledge([transaction]) : undefined
                      }
                    />
                  ))
                )}
              </tbody>
            </table>
          </HorizontalScrollArea>

          <div className="flex flex-col gap-4 items-center">
            {!isInitialLoading && (
              <Pagination hasMore={hasMore} isLoading={isLoadingMore} onLoadMore={handleLoadMore} />
            )}
          </div>
        </div>

        <TransactionDetailsDialog
          transaction={selectedTransaction}
          onClose={() => setSelectedTransaction(null)}
          onRefresh={refreshTransactions}
        />

        {showDownloadDialog && (
          <DownloadDetailsDialog
            open
            onClose={() => setShowDownloadDialog(false)}
            viewDefaults={reportViewDefaults}
          />
        )}

        <ConfirmDialog
          open={bulkConfirmMode !== null}
          onClose={() => setBulkConfirmMode(null)}
          title={
            bulkConfirmMode === 'retry' ? 'Retry failed actions' : 'Clear transaction error states'
          }
          description={
            bulkConfirmMode === 'retry'
              ? `Queue a retry of the failed action for ${recoverableSelectedCount} transaction${recoverableSelectedCount === 1 ? '' : 's'}?`
              : `Clear the error state for ${recoverableSelectedCount} transaction${recoverableSelectedCount === 1 ? '' : 's'} so processing can continue?`
          }
          confirmLabel={bulkConfirmMode === 'retry' ? 'Retry failed actions' : 'Clear error states'}
          onConfirm={() => {
            if (!bulkConfirmMode) return;
            void handleBulkRecoverErrors(bulkConfirmMode === 'retry').finally(() =>
              setBulkConfirmMode(null),
            );
          }}
          isLoading={isRecovering}
        />

        <ConfirmDialog
          open={isAcknowledgeOpen}
          onClose={() => setIsAcknowledgeOpen(false)}
          title="Acknowledge transactions"
          description={`Hide ${acknowledgeTargets.length} transaction${acknowledgeTargets.length === 1 ? '' : 's'} from Needs Action? The error state, transactions and on-chain state do not change. A new error shows the row again.`}
          confirmLabel="Acknowledge"
          onConfirm={() => {
            void handleAcknowledge(acknowledgeTargets).finally(() => setIsAcknowledgeOpen(false));
          }}
          isLoading={isAcknowledging}
        />
      </AnimatedPage>
    </MainLayout>
  );
}
