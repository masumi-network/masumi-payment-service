import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';

import { cn, formatAssetAmount } from '@/lib/utils';
import { formatDateTime } from '@/lib/format-date';
import { MainLayout } from '@/components/layout/MainLayout';
import { RefreshButton } from '@/components/RefreshButton';
import Head from 'next/head';
import { useAppContext } from '@/lib/contexts/AppContext';
import { TransactionTableSkeleton } from '@/components/skeletons/TransactionTableSkeleton';
import {
  tableActionsCellCompactClass,
  tableActionsHeadCompactClass,
} from '@/components/ui/table-actions-column';
import { MoreHorizontal, FlaskConical } from 'lucide-react';
import { Tabs } from '@/components/ui/tabs';
import { Pagination } from '@/components/ui/pagination';
import { CopyButton } from '@/components/ui/copy-button';
import TransactionDetailsDialog from '@/components/transactions/TransactionDetailsDialog';
import { DownloadDetailsDialog } from '@/components/transactions/DownloadDetailsDialog';
import { Download } from 'lucide-react';
import { useTransactions, OnChainStateFilter, ON_CHAIN_STATES } from '@/lib/hooks/useTransactions';
import { AnimatedPage } from '@/components/ui/animated-page';
import { SearchInput } from '@/components/ui/search-input';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { useDebouncedValue } from '@/lib/hooks/useDebouncedValue';
import { parseAmountSearchRange, parseAmountToBigInt } from '@/lib/parseAmountSearchRange';
import Link from 'next/link';
import { PaymentSourceTypeBadge } from '@/components/payment-sources/PaymentSourceTypeBadge';
import { TransactionAgentIdentifierCell } from '@/components/transactions/TransactionAgentIdentifierCell';
import { getLatestTxHash } from '@/components/transactions/transaction-format.helpers';
import { Checkbox } from '@/components/ui/checkbox';
import {
  TransactionFilters,
  EMPTY_FILTERS,
  type TransactionFilterState,
} from '@/components/transactions/TransactionFilters';
import { buildTransactionReportViewDefaults } from '@/components/transactions/download-details.helpers';
import { useBulkClearTransactionErrors } from '@/lib/hooks/useBulkClearTransactionErrors';
import { toast } from 'react-toastify';
import { useResync } from '@/lib/hooks/useResync';

type Transaction = ReturnType<typeof useTransactions>['transactions'][number];

const formatStatus = (status: string | null) => {
  if (!status) return '—';
  return status.replace(/([A-Z])/g, ' $1').trim();
};

const isHydraTransaction = (transaction: Transaction) =>
  transaction.CurrentTransaction?.layer === 'L2';

// The layer (L1 vs Hydra L2) is only known once the request has been picked up
// and locked (i.e. a CurrentTransaction exists). Before that, show neither.
const getTransactionLayerLabel = (transaction: Transaction): 'Hydra L2' | 'L1' | null => {
  const layer = transaction.CurrentTransaction?.layer;
  if (layer === 'L2') return 'Hydra L2';
  if (layer === 'L1') return 'L1';
  return null;
};

const getHydraHeadId = (transaction: Transaction) =>
  transaction.CurrentTransaction?.hydraHeadId ?? null;

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
  const isNeedsActionTab = activeTab === 'Needs Action';
  // Error recovery posts to /payment|purchase/error-state-recovery, both
  // pay-authenticated. Read-only sessions keep the Needs Action tab as a
  // read-only view but get no selection column and no bulk action bar.
  const canRecoverErrors = capabilities.canPay;
  const showSelection = isNeedsActionTab && canRecoverErrors;

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

  // Unfiltered call for tab badge counts (reuses dashboard cache when no args); only this instance updates localStorage
  const { transactions: allTransactionsForCounts, markAllAsRead } = useTransactions();

  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);
  const [showDownloadDialog, setShowDownloadDialog] = useState(false);
  // Multi-row selection is only offered on the Needs Action tab, where every row
  // is in an error state that can be bulk-cleared. Keyed by transaction id.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const { recoverErrors, isRecovering } = useBulkClearTransactionErrors();
  const [bulkRecoveryMode, setBulkRecoveryMode] = useState<'clear' | 'retry' | null>(null);
  const isLoadingMore = isFetchingNextPage;
  const isInitialLoading = isLoading && !transactions.length;

  const tabs = useMemo(() => {
    const seenIds = new Set<string>();
    const dedupedTransactions = allTransactionsForCounts.filter((tx) => {
      if (!tx.id) return true;
      if (seenIds.has(tx.id)) return false;
      seenIds.add(tx.id);
      return true;
    });

    const refundCount = dedupedTransactions.filter(
      (t) => t.onChainState === 'RefundRequested',
    ).length;
    const disputeCount = dedupedTransactions.filter((t) => t.onChainState === 'Disputed').length;
    // Mirrors the backend filterNeedsManualAction predicate (buildNeedsManualActionFilter):
    // parked in WaitingForManualAction or a recorded NextAction error.
    const needsActionCount = dedupedTransactions.filter(
      (t) =>
        t.NextAction?.requestedAction === 'WaitingForManualAction' || !!t.NextAction?.errorType,
    ).length;

    return [
      { name: 'All', count: null },
      { name: 'Payments', count: null },
      { name: 'Purchases', count: null },
      {
        name: 'Refund Requests',
        count: refundCount || null,
        variant: 'alert' as const,
      },
      {
        name: 'Disputes',
        count: disputeCount || null,
        variant: 'alert' as const,
      },
      {
        name: 'Needs Action',
        count: needsActionCount || null,
        variant: 'alert' as const,
      },
    ];
  }, [allTransactionsForCounts]);

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

    const amountRange = parseAmountSearchRange(query);
    // Mirror backend looksLikeHash (HASH_QUERY_MIN_LENGTH): the hash columns and
    // the head ID are only searched for a hex query of 5+ characters.
    const isHashQuery = query.length >= 5 && /^[0-9a-f]+$/.test(query);
    // Mirror backend buildMatchingLayers: exact match plus the 'hydra' alias.
    const matchingLayer =
      query === 'hydra' ? 'L2' : query === 'l1' || query === 'l2' ? query.toUpperCase() : null;

    // Mirror backend buildMatchingStates
    const matchingStates = ON_CHAIN_STATES.filter(
      (s) => s.toLowerCase().includes(query) || formatStatus(s).toLowerCase().includes(query),
    );

    return filteredTransactions.filter((tx) => {
      if (tx.id?.toLowerCase().includes(query)) return true;
      if (tx.blockchainIdentifier?.toLowerCase() === query) return true;
      if (isHashQuery) {
        if (tx.CurrentTransaction?.txHash?.toLowerCase().includes(query)) return true;
        if (tx.TransactionHistory?.some((h) => h.txHash?.toLowerCase().includes(query)))
          return true;
        if (tx.inputHash?.toLowerCase().includes(query)) return true;
        if (tx.resultHash?.toLowerCase().includes(query)) return true;
        if (tx.CurrentTransaction?.hydraHeadId?.toLowerCase().includes(query)) return true;
      }
      if (matchingLayer && tx.CurrentTransaction?.layer === matchingLayer) return true;
      if (tx.SmartContractWallet?.walletAddress?.toLowerCase().includes(query)) return true;
      if (matchingStates.length > 0 && tx.onChainState && matchingStates.includes(tx.onChainState))
        return true;
      if (tx.agentIdentifier?.toLowerCase().includes(query)) return true;
      if (tx.agentName?.toLowerCase().includes(query)) return true;
      if (amountRange) {
        const funds =
          tx.type === 'payment' ? tx.RequestedFunds : tx.type === 'purchase' ? tx.PaidFunds : [];
        if (
          funds?.some((f) => {
            const amt = parseAmountToBigInt(f.amount);
            return amt != null && amt >= amountRange.min && amt <= amountRange.max;
          })
        )
          return true;
      }
      return false;
    });
  }, [filteredTransactions, searchQuery, debouncedSearchQuery, isPlaceholderData]);

  const refreshTransactions = useCallback(() => {
    void refetchTransactions?.();
  }, [refetchTransactions]);

  // Error type has no server-side param, so narrow it client-side. Pagination-limited.
  const visibleTransactions = useMemo(() => {
    if (!filters.errorType) return displayTransactions;
    return displayTransactions.filter((tx) => tx.NextAction?.errorType === filters.errorType);
  }, [displayTransactions, filters.errorType]);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const selectableIds = useMemo(
    () => visibleTransactions.map((tx) => tx.id).filter((id): id is string => Boolean(id)),
    [visibleTransactions],
  );
  const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedIds.has(id));
  const someSelected = selectedIds.size > 0 && !allSelected;

  const toggleAll = useCallback(() => {
    setSelectedIds((prev) => {
      const everySelected = selectableIds.length > 0 && selectableIds.every((id) => prev.has(id));
      return everySelected ? new Set() : new Set(selectableIds);
    });
  }, [selectableIds]);

  const toggleRow = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleBulkRecoverErrors = useCallback(
    async (retryPreviousAction: boolean) => {
      const selected = visibleTransactions.filter((tx) => tx.id && selectedIds.has(tx.id));
      if (selected.length === 0) return;

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
        setSelectedIds(new Set(failedIds));
        await resync('transactions');
        refreshTransactions();
      } finally {
        setBulkRecoveryMode(null);
      }
    },
    [visibleTransactions, selectedIds, recoverErrors, refreshTransactions, resync],
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

  const getStatusColor = (status: string | null, hasError?: boolean) => {
    if (hasError) return 'text-destructive';
    switch (status?.toLowerCase()) {
      case 'fundslocked':
        return 'text-yellow-500';
      case 'withdrawn':
      case 'resultsubmitted':
        return 'text-green-500';
      case 'refundrequested':
      case 'withdrawauthorized':
      case 'refundauthorized':
        return 'text-orange-500';
      case 'refundwithdrawn':
        return 'text-blue-500';
      case 'disputed':
      case 'disputedwithdrawn':
        return 'text-destructive';
      default:
        return 'text-muted-foreground';
    }
  };

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
                  href="https://www.masumi.network/dev/masumi/core-concepts/agent-to-agent-payments"
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
          </div>

          {showSelection && selectedIds.size > 0 && (
            <div className="flex items-center justify-between gap-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2 animate-fade-in">
              <span className="text-sm font-medium">{selectedIds.size} selected</span>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedIds(new Set())}
                  disabled={isRecovering}
                >
                  Cancel
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleBulkRecoverErrors(false)}
                  disabled={isRecovering}
                >
                  {bulkRecoveryMode === 'clear'
                    ? 'Clearing error states...'
                    : `Clear error state (${selectedIds.size})`}
                </Button>
                <Button
                  size="sm"
                  onClick={() => handleBulkRecoverErrors(true)}
                  disabled={isRecovering}
                >
                  {bulkRecoveryMode === 'retry'
                    ? 'Queueing retries...'
                    : `Retry failed action (${selectedIds.size})`}
                </Button>
              </div>
            </div>
          )}

          <div className="border rounded-lg overflow-x-auto">
            <table
              className={cn(
                'w-full transition-opacity duration-150',
                isSearchPending && 'opacity-70',
              )}
            >
              <thead className="bg-muted/30 dark:bg-muted/15">
                <tr className="border-b">
                  {showSelection && (
                    <th className="p-4 pl-6 w-10">
                      <Checkbox
                        checked={allSelected ? true : someSelected ? 'indeterminate' : false}
                        onCheckedChange={toggleAll}
                        aria-label="Select all transactions"
                        disabled={selectableIds.length === 0}
                      />
                    </th>
                  )}
                  <th
                    className={cn(
                      'p-4 text-left text-sm font-medium text-muted-foreground',
                      !showSelection && 'pl-6',
                    )}
                  >
                    Type
                  </th>
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
                  <th className={tableActionsHeadCompactClass}></th>
                </tr>
              </thead>
              <tbody>
                {isInitialLoading || (visibleTransactions.length === 0 && isSearchPending) ? (
                  <TransactionTableSkeleton rows={5} />
                ) : visibleTransactions.length === 0 ? (
                  <tr>
                    <td colSpan={showSelection ? 10 : 9}>
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
                    <tr
                      key={transaction.id}
                      className={cn(
                        'border-b last:border-b-0 animate-fade-in opacity-0 transition-[background-color,opacity] duration-150',
                        transaction.NextAction?.errorType
                          ? 'bg-destructive/10 border-l-2 border-l-destructive'
                          : '',
                        'cursor-pointer hover:bg-muted/50',
                        transaction.id && selectedIds.has(transaction.id) && 'bg-muted/50',
                      )}
                      style={{ animationDelay: `${Math.min(index, 9) * 40}ms` }}
                      onClick={() => setSelectedTransaction(transaction)}
                    >
                      {showSelection && (
                        <td className="p-4 pl-6 w-10" onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={transaction.id ? selectedIds.has(transaction.id) : false}
                            onCheckedChange={() => transaction.id && toggleRow(transaction.id)}
                            disabled={!transaction.id}
                            aria-label="Select transaction"
                          />
                        </td>
                      )}
                      <td className={cn('p-4', !showSelection && 'pl-6')}>
                        <span className="capitalize">{transaction.type}</span>
                      </td>
                      <td className="p-4">
                        {(() => {
                          const displayTxHash = getLatestTxHash(transaction);
                          return (
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-sm text-muted-foreground">
                                {displayTxHash
                                  ? `${displayTxHash.slice(0, 8)}...${displayTxHash.slice(-8)}`
                                  : '—'}
                              </span>
                              {displayTxHash && <CopyButton value={displayTxHash} />}
                            </div>
                          );
                        })()}
                      </td>
                      <td className="p-4">
                        <TransactionAgentIdentifierCell
                          agentIdentifier={transaction.agentIdentifier}
                          agentName={transaction.agentName}
                          smartContractAddress={
                            transaction.PaymentSource?.smartContractAddress ?? null
                          }
                          network={transaction.PaymentSource?.network}
                        />
                      </td>
                      <td className="p-4">
                        {transaction.type === 'payment' && transaction.RequestedFunds?.length
                          ? transaction.RequestedFunds.map((fund, index) => (
                              <div key={index} className="text-sm">
                                {formatAssetAmount(fund.amount, fund.unit, network)}
                              </div>
                            ))
                          : transaction.type === 'purchase' && transaction.PaidFunds?.length
                            ? transaction.PaidFunds.map((fund, index) => (
                                <div key={index} className="text-sm">
                                  {formatAssetAmount(fund.amount, fund.unit, network)}
                                </div>
                              ))
                            : '—'}
                      </td>
                      <td className="p-4">
                        <div className="flex flex-col gap-1">
                          <span>{transaction.PaymentSource.network}</span>
                          <PaymentSourceTypeBadge
                            paymentSourceType={transaction.PaymentSource.paymentSourceType}
                            showDefault
                          />
                          <div className="flex items-center gap-1.5">
                            {getTransactionLayerLabel(transaction) ? (
                              <Badge
                                variant={isHydraTransaction(transaction) ? 'success' : 'outline'}
                                className="w-fit"
                              >
                                {getTransactionLayerLabel(transaction)}
                              </Badge>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                            {isHydraTransaction(transaction) && getHydraHeadId(transaction) && (
                              <span
                                className="max-w-[120px] truncate font-mono text-xs text-muted-foreground"
                                title={getHydraHeadId(transaction) ?? undefined}
                              >
                                {getHydraHeadId(transaction)}
                              </span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="p-4">
                        <span
                          className={getStatusColor(
                            transaction.onChainState,
                            !!transaction.NextAction?.errorType,
                          )}
                        >
                          {transaction.onChainState === 'Disputed' ? (
                            <span className="flex items-center gap-1">
                              <div className="w-2 h-2 bg-orange-500 rounded-full animate-subtle-pulse"></div>
                              {formatStatus(transaction.onChainState)}
                            </span>
                          ) : (
                            formatStatus(transaction.onChainState)
                          )}
                        </span>
                      </td>
                      <td className="p-4">
                        {transaction.onChainState === 'ResultSubmitted'
                          ? formatDateTime(transaction.unlockTime)
                          : '—'}
                      </td>
                      <td className="p-4">{formatDateTime(transaction.createdAt)}</td>
                      <td className={tableActionsCellCompactClass}>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="More actions"
                          className="h-8 w-8"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

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
      </AnimatedPage>
    </MainLayout>
  );
}
