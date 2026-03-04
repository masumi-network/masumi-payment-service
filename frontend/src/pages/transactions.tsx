import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Button } from '@/components/ui/button';

import { cn, formatFundUnit } from '@/lib/utils';
import { MainLayout } from '@/components/layout/MainLayout';
import { RefreshButton } from '@/components/RefreshButton';
import Head from 'next/head';
import { useAppContext } from '@/lib/contexts/AppContext';
import { TransactionTableSkeleton } from '@/components/skeletons/TransactionTableSkeleton';
import { MoreHorizontal, FlaskConical } from 'lucide-react';
import { Tabs } from '@/components/ui/tabs';
import { Pagination } from '@/components/ui/pagination';
import { CopyButton } from '@/components/ui/copy-button';
import TransactionDetailsDialog from '@/components/transactions/TransactionDetailsDialog';
import { DownloadDetailsDialog } from '@/components/transactions/DownloadDetailsDialog';
import { Download } from 'lucide-react';
import { dateRangeUtils } from '@/lib/utils';
import { useTransactions, OnChainStateFilter, ON_CHAIN_STATES } from '@/lib/hooks/useTransactions';
import { AnimatedPage } from '@/components/ui/animated-page';
import { SearchInput } from '@/components/ui/search-input';
import { EmptyState } from '@/components/ui/empty-state';
import { useDebouncedValue } from '@/lib/hooks/useDebouncedValue';
import Link from 'next/link';

type Transaction = ReturnType<typeof useTransactions>['transactions'][number];

/**
 * Parse a numeric search string into a lovelace range for amount filtering.
 * Mirrors the backend's parseAmountSearchRange in src/utils/shared/queries.ts.
 */
function parseAmountSearchRange(query: string): { min: number; max: number } | undefined {
  const numericMatch = query.match(/^(\d+\.?\d*)$/);
  if (!numericMatch) return undefined;

  const numericValue = parseFloat(numericMatch[1]);
  if (isNaN(numericValue) || numericValue < 0) return undefined;

  const hasDecimal = numericMatch[1].includes('.');
  if (hasDecimal) {
    const decimalDigits = numericMatch[1].split('.')[1].length;
    const precision = Math.pow(10, decimalDigits);
    const min = Math.floor(numericValue * 1000000);
    const nextStep = (Math.floor(numericValue * precision) + 1) / precision;
    const max = Math.floor(nextStep * 1000000) - 1;
    return { min, max };
  }

  const min = Math.floor(numericValue * 1000000);
  const max = Math.floor((numericValue + 1) * 1000000) - 1;
  return { min, max };
}

const formatTimestamp = (timestamp: string | null | undefined): string => {
  if (!timestamp) return '—';

  if (/^\d+$/.test(timestamp)) {
    return new Date(parseInt(timestamp)).toLocaleString();
  }

  return new Date(timestamp).toLocaleString();
};

const formatStatus = (status: string | null) => {
  if (!status) return '—';
  return status.replace(/([A-Z])/g, ' $1').trim();
};

export default function Transactions() {
  const { apiClient, selectedPaymentSourceId, network, selectedPaymentSource } = useAppContext();

  const [activeTab, setActiveTab] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');
  const debouncedSearchQuery = useDebouncedValue(searchQuery);

  const filterParams = useMemo(() => {
    const params: {
      filterOnChainState?: OnChainStateFilter;
      searchQuery?: string;
      transactionType?: 'payment' | 'purchase';
    } = {};

    if (activeTab === 'Payments') params.transactionType = 'payment';
    else if (activeTab === 'Purchases') params.transactionType = 'purchase';
    else if (activeTab === 'Refund Requests') params.filterOnChainState = 'RefundRequested';
    else if (activeTab === 'Disputes') params.filterOnChainState = 'Disputed';

    if (debouncedSearchQuery) params.searchQuery = debouncedSearchQuery;

    return params;
  }, [activeTab, debouncedSearchQuery]);

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

  // Format price helper function
  const formatPrice = (amount: string | undefined) => {
    if (!amount) return '—';
    const numericAmount = parseInt(amount) / 1000000;
    return new Intl.NumberFormat(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
      useGrouping: true,
    }).format(numericAmount);
  };

  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);
  const [showDownloadDialog, setShowDownloadDialog] = useState(false);
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
  // to avoid items appearing/disappearing when the server responds.
  const displayTransactions = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    if (!query || (query === debouncedSearchQuery.toLowerCase().trim() && !isPlaceholderData))
      return filteredTransactions;

    const amountRange = parseAmountSearchRange(query);

    // Mirror backend buildMatchingStates
    const matchingStates = ON_CHAIN_STATES.filter(
      (s) => s.toLowerCase().includes(query) || formatStatus(s).toLowerCase().includes(query),
    );

    return filteredTransactions.filter((tx) => {
      if (tx.id?.toLowerCase().includes(query)) return true;
      if (tx.CurrentTransaction?.txHash?.toLowerCase().includes(query)) return true;
      if (tx.SmartContractWallet?.walletAddress?.toLowerCase().includes(query)) return true;
      if (matchingStates.length > 0 && tx.onChainState && matchingStates.includes(tx.onChainState))
        return true;
      if (amountRange) {
        const funds =
          tx.type === 'payment' ? tx.RequestedFunds : tx.type === 'purchase' ? tx.PaidFunds : [];
        if (
          funds?.some((f) => {
            const amt = parseInt(f.amount);
            return amt >= amountRange.min && amt <= amountRange.max;
          })
        )
          return true;
      }
      return false;
    });
  }, [filteredTransactions, searchQuery, debouncedSearchQuery, isPlaceholderData]);

  // When context changes, clear "new transactions" badge via the hook (single source of truth for localStorage)
  const markAllAsReadRef = useRef(markAllAsRead);
  useEffect(() => {
    markAllAsReadRef.current = markAllAsRead;
  }, [markAllAsRead]);
  useEffect(() => {
    markAllAsReadRef.current();
  }, [network, apiClient, selectedPaymentSourceId]);

  const refreshTransactions = useCallback(() => {
    refetchTransactions?.();
  }, [refetchTransactions]);

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
        return 'text-orange-500';
      case 'refundwithdrawn':
        return 'text-blue-500';
      case 'disputed':
      case 'disputedwithdrawn':
        return 'text-red-500';
      default:
        return 'text-muted-foreground';
    }
  };

  // Generate CSV data for transactions
  const generateCSVData = useCallback(
    (transactions: Transaction[]): string => {
      const headers = [
        'Transaction Type',
        'Transaction Hash',
        'Payment Amounts',
        'Network',
        'Status',
        'Date',
        'Fee rate (%)',
      ];
      const rows = transactions.map((transaction) => {
        const feeRatePermille = selectedPaymentSource?.feeRatePermille;
        const feeRateDisplay =
          typeof feeRatePermille === 'number' ? (feeRatePermille / 10).toFixed(1) + '%' : 'Unknown';
        const paymentAmounts = [];
        if (transaction.type === 'payment' && transaction.RequestedFunds) {
          paymentAmounts.push(
            ...transaction.RequestedFunds.map((fund) => ({
              amount: formatPrice(fund.amount),
              unit: formatFundUnit(fund.unit, network),
            })),
          );
        } else if (transaction.type === 'purchase' && transaction.PaidFunds) {
          paymentAmounts.push(
            ...transaction.PaidFunds.map((fund) => ({
              amount: formatPrice(fund.amount),
              unit: formatFundUnit(fund.unit, network),
            })),
          );
        }
        const amount = paymentAmounts.map((amount) => `${amount.amount} ${amount.unit}`).join(', ');

        const hash = transaction.CurrentTransaction?.txHash || '—';
        const status = formatStatus(transaction.onChainState);
        const date = new Date(transaction.createdAt).toLocaleString();

        return [
          transaction.type,
          hash,
          amount,
          transaction.PaymentSource.network,
          status,
          date,
          feeRateDisplay,
        ];
      });

      return [headers, ...rows].map((row) => row.map((field) => `"${field}"`).join(',')).join('\n');
    },
    [selectedPaymentSource?.feeRatePermille, network],
  );

  // Download CSV file
  const downloadCSV = (transactions: Transaction[], filename: string = 'transactions.csv') => {
    const csvData = generateCSVData(transactions);
    const blob = new Blob([csvData], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
                  href="https://docs.masumi.network/core-concepts/agent-to-agent-payments"
                  target="_blank"
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
                disabled={displayTransactions.length === 0}
                variant="outline"
                className="flex items-center gap-2 btn-hover-lift"
              >
                <Download className="h-4 w-4" />
                Download CSV
              </Button>
              <Link href="/developers">
                <Button className="flex items-center gap-2 btn-hover-lift">
                  <FlaskConical className="h-4 w-4" />
                  Test transaction
                </Button>
              </Link>
            </div>
          </div>

          <Tabs
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={(tab) => {
              setActiveTab(tab);
            }}
          />

          <div className="flex items-center justify-between">
            <div className="flex-1">
              <SearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="Search by ID, hash, status, amount..."
                className="max-w-xs"
                isLoading={isSearchPending && !!searchQuery}
              />
            </div>
          </div>

          <div className="border rounded-lg overflow-x-auto">
            <table
              className={cn(
                'w-full transition-opacity duration-150',
                isSearchPending && 'opacity-70',
              )}
            >
              <thead className="bg-muted/30 dark:bg-muted/15">
                <tr className="border-b">
                  <th className="p-4 text-left text-sm font-medium text-muted-foreground pl-6">
                    Type
                  </th>
                  <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                    Transaction Hash
                  </th>
                  <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                    Amount
                  </th>
                  <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                    Network
                  </th>
                  <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                    Status
                  </th>
                  <th className="p-4 text-left text-sm font-medium text-muted-foreground">
                    Unlock Time
                  </th>
                  <th className="p-4 text-left text-sm font-medium text-muted-foreground">Date</th>
                  <th className="p-4 text-left text-sm font-medium text-muted-foreground pr-8"></th>
                </tr>
              </thead>
              <tbody>
                {isInitialLoading || (displayTransactions.length === 0 && isSearchPending) ? (
                  <TransactionTableSkeleton rows={5} />
                ) : displayTransactions.length === 0 ? (
                  <tr>
                    <td colSpan={8}>
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
                          !searchQuery ? (
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
                  displayTransactions.map((transaction, index) => (
                    <tr
                      key={transaction.id}
                      className={cn(
                        'border-b last:border-b-0 animate-fade-in opacity-0 transition-[background-color,opacity] duration-150',
                        transaction.NextAction?.errorType
                          ? 'bg-destructive/10 border-l-2 border-l-destructive'
                          : '',
                        'cursor-pointer hover:bg-muted/50',
                      )}
                      style={{ animationDelay: `${Math.min(index, 9) * 40}ms` }}
                      onClick={() => setSelectedTransaction(transaction)}
                    >
                      <td className="p-4 pl-6">
                        <span className="capitalize">{transaction.type}</span>
                      </td>
                      <td className="p-4">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm text-muted-foreground">
                            {transaction.CurrentTransaction?.txHash
                              ? `${transaction.CurrentTransaction.txHash.slice(0, 8)}...${transaction.CurrentTransaction.txHash.slice(-8)}`
                              : '—'}
                          </span>
                          {transaction.CurrentTransaction?.txHash && (
                            <CopyButton value={transaction.CurrentTransaction?.txHash} />
                          )}
                        </div>
                      </td>
                      <td className="p-4">
                        {transaction.type === 'payment' && transaction.RequestedFunds?.length
                          ? transaction.RequestedFunds.map((fund, index) => {
                              const amount = formatPrice(fund.amount);
                              const unit = formatFundUnit(fund.unit, network);
                              return (
                                <div key={index} className="text-sm">
                                  {amount} {unit}
                                </div>
                              );
                            })
                          : transaction.type === 'purchase' && transaction.PaidFunds?.length
                            ? transaction.PaidFunds.map((fund, index) => {
                                const amount = formatPrice(fund.amount);
                                const unit = formatFundUnit(fund.unit, network);
                                return (
                                  <div key={index} className="text-sm">
                                    {amount} {unit}
                                  </div>
                                );
                              })
                            : '—'}
                      </td>
                      <td className="p-4">{transaction.PaymentSource.network}</td>
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
                          ? formatTimestamp(transaction.unlockTime)
                          : '—'}
                      </td>
                      <td className="p-4">{new Date(transaction.createdAt).toLocaleString()}</td>
                      <td className="p-4 pr-8">
                        <Button variant="ghost" size="icon" className="h-8 w-8">
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

        <DownloadDetailsDialog
          open={showDownloadDialog}
          onClose={() => setShowDownloadDialog(false)}
          onDownload={(startDate, endDate, filteredTransactions) => {
            downloadCSV(
              filteredTransactions,
              `transactions-${activeTab.toLowerCase()}-${dateRangeUtils.formatDateRange(startDate, endDate).replace(/\s+/g, '-')}.csv`,
            );
          }}
        />
      </AnimatedPage>
    </MainLayout>
  );
}
