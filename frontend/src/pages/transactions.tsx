import { useState, useEffect, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { cn, formatFundUnit } from '@/lib/utils';
import { MainLayout } from '@/components/layout/MainLayout';
import { RefreshButton } from '@/components/RefreshButton';
import Head from 'next/head';
import { useAppContext } from '@/lib/contexts/AppContext';
import { Spinner } from '@/components/ui/spinner';
import { Search } from 'lucide-react';
import { Tabs } from '@/components/ui/tabs';
import { Pagination } from '@/components/ui/pagination';
import { CopyButton } from '@/components/ui/copy-button';
import TransactionDetailsDialog from '@/components/transactions/TransactionDetailsDialog';
import { DownloadDetailsDialog } from '@/components/transactions/DownloadDetailsDialog';
import { Download } from 'lucide-react';
import { dateRangeUtils } from '@/lib/utils';
import { useTransactions } from '@/lib/hooks/useTransactions';

type Transaction = ReturnType<typeof useTransactions>['transactions'][number];

const formatTimestamp = (timestamp: string | null | undefined): string => {
  if (!timestamp) return '—';

  if (/^\d+$/.test(timestamp)) {
    return new Date(parseInt(timestamp)).toLocaleString();
  }

  return new Date(timestamp).toLocaleString();
};

export default function Transactions() {
  const { apiClient, state, selectedPaymentSourceId } = useAppContext();
  const {
    transactions,
    isLoading,
    hasMore,
    loadMore,
    refetch: refetchTransactions,
    isFetchingNextPage,
  } = useTransactions();

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

  const [activeTab, setActiveTab] = useState('All');
  const [selectedTransactions, setSelectedTransactions] = useState<string[]>(
    [],
  );

  const [filteredTransactions, setFilteredTransactions] = useState<
    Transaction[]
  >([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTransaction, setSelectedTransaction] =
    useState<Transaction | null>(null);
  const [showDownloadDialog, setShowDownloadDialog] = useState(false);
  const isLoadingMore = isFetchingNextPage;
  const isInitialLoading = isLoading && transactions.length === 0;
  const allTransactions = useMemo(() => transactions, [transactions]);

  const tabs = useMemo(() => {
    // Apply the same deduplication logic as filterTransactions
    const seenHashes = new Set();
    const dedupedTransactions = [...allTransactions].filter((tx) => {
      const id = tx.id;
      if (!id) return true;
      if (seenHashes.has(id)) return false;
      seenHashes.add(id);
      return true;
    });

    const refundCount = dedupedTransactions.filter(
      (t) => t.onChainState === 'RefundRequested',
    ).length;
    const disputeCount = dedupedTransactions.filter(
      (t) => t.onChainState === 'Disputed',
    ).length;

    return [
      { name: 'All', count: null },
      { name: 'Payments', count: null },
      { name: 'Purchases', count: null },
      {
        name: 'Refund Requests',
        count: refundCount || null,
      },
      {
        name: 'Disputes',
        count: disputeCount || null,
      },
    ];
  }, [allTransactions]);

  const filterTransactions = useCallback(() => {
    const seenHashes = new Set();
    let filtered = [...allTransactions].filter((tx) => {
      const id = tx.id;
      if (!id) return true;
      if (seenHashes.has(id)) return false;
      seenHashes.add(id);
      return true;
    });

    if (activeTab === 'Payments') {
      filtered = filtered.filter((t) => t.type === 'payment');
    } else if (activeTab === 'Purchases') {
      filtered = filtered.filter((t) => t.type === 'purchase');
    } else if (activeTab === 'Refund Requests') {
      filtered = filtered.filter((t) => t.onChainState === 'RefundRequested');
    } else if (activeTab === 'Disputes') {
      filtered = filtered.filter((t) => t.onChainState === 'Disputed');
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter((transaction) => {
        const matchId = transaction.id?.toLowerCase().includes(query) || false;
        const matchHash =
          transaction.CurrentTransaction?.txHash
            ?.toLowerCase()
            .includes(query) || false;
        const matchState =
          transaction.onChainState?.toLowerCase().includes(query) || false;
        const matchType =
          transaction.type?.toLowerCase().includes(query) || false;
        const matchNetwork =
          transaction.PaymentSource?.network?.toLowerCase().includes(query) ||
          false;
        const matchWallet =
          transaction.SmartContractWallet?.walletAddress
            ?.toLowerCase()
            .includes(query) || false;

        const matchRequestedFunds =
          transaction.type === 'payment' &&
          transaction.RequestedFunds?.some(
            (fund) => parseInt(fund.amount) / 1000000,
          )
            .toString()
            .toLowerCase()
            .includes(query);
        const matchPaidFunds =
          transaction.type === 'purchase' &&
          transaction.PaidFunds?.some((fund) => parseInt(fund.amount) / 1000000)
            .toString()
            .toLowerCase()
            .includes(query);

        return (
          matchId ||
          matchHash ||
          matchState ||
          matchType ||
          matchNetwork ||
          matchWallet ||
          matchRequestedFunds ||
          matchPaidFunds
        );
      });
    }

    setFilteredTransactions(filtered);
  }, [allTransactions, searchQuery, activeTab]);

  useEffect(() => {
    // Set last visit timestamp when user visits transactions page
    if (typeof window !== 'undefined') {
      localStorage.setItem(
        'masumi_last_transactions_visit',
        new Date().toISOString(),
      );
      localStorage.setItem('masumi_new_transactions_count', '0');
    }
  }, [state.network, apiClient, selectedPaymentSourceId]);

  useEffect(() => {
    filterTransactions();
  }, [filterTransactions, searchQuery, activeTab]);

  const refreshTransactions = useCallback(() => {
    refetchTransactions?.();
  }, [refetchTransactions]);

  const handleLoadMore = useCallback(() => {
    if (hasMore && !isLoadingMore) {
      loadMore();
    }
  }, [hasMore, isLoadingMore, loadMore]);

  const handleSelectTransaction = (id: string) => {
    setSelectedTransactions((prev) =>
      prev.includes(id)
        ? prev.filter((transactionId) => transactionId !== id)
        : [...prev, id],
    );
  };

  const handleSelectAll = () => {
    if (filteredTransactions.length === selectedTransactions.length) {
      setSelectedTransactions([]);
    } else {
      setSelectedTransactions(filteredTransactions.map((t) => t.id));
    }
  };

  const getStatusColor = (status: string, hasError?: boolean) => {
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

  const formatStatus = (status: string) => {
    if (!status) return '—';
    return status.replace(/([A-Z])/g, ' $1').trim();
  };

  // Generate CSV data for transactions
  const generateCSVData = (transactions: Transaction[]): string => {
    const headers = [
      'Transaction Type',
      'Transaction Hash',
      'Payment Amounts',
      'Network',
      'Status',
      'Date',
      'Fee Rate Permille',
    ];
    const rows = transactions.map((transaction) => {
      const selectedPaymentSource = state.paymentSources.find(
        (ps) => ps.id === transaction.PaymentSource.id,
      );
      const feeRatePermille =
        selectedPaymentSource?.feeRatePermille ?? 'Unknown';
      const paymentAmounts = [];
      if (transaction.type === 'payment' && transaction.RequestedFunds) {
        paymentAmounts.push(
          ...transaction.RequestedFunds.map((fund) => ({
            amount: formatPrice(fund.amount),
            unit: formatFundUnit(fund.unit, state.network),
          })),
        );
      } else if (transaction.type === 'purchase' && transaction.PaidFunds) {
        paymentAmounts.push(
          ...transaction.PaidFunds.map((fund) => ({
            amount: formatPrice(fund.amount),
            unit: formatFundUnit(fund.unit, state.network),
          })),
        );
      }
      const amount = paymentAmounts
        .map((amount) => `${amount.amount} ${amount.unit}`)
        .join(', ');

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
        feeRatePermille,
      ];
    });

    return [headers, ...rows]
      .map((row) => row.map((field) => `"${field}"`).join(','))
      .join('\n');
  };

  // Download CSV file
  const downloadCSV = (
    transactions: Transaction[],
    filename: string = 'transactions.csv',
  ) => {
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
      <div>
        <div className="mb-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-xl font-semibold mb-1">Transactions</h1>
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
              {(() => {
                const selectedPaymentSource = state.paymentSources.find(
                  (ps) => ps.id === selectedPaymentSourceId,
                );
                const feeRate = selectedPaymentSource?.feeRatePermille;

                if (!feeRate) {
                  return (
                    <p className="text-xs text-muted-foreground mt-1">
                      Fee rate: none applied
                      {selectedPaymentSource
                        ? ` (${selectedPaymentSource.network})`
                        : ' (default)'}
                    </p>
                  );
                }

                return (
                  <p className="text-xs text-muted-foreground mt-1">
                    Fee rate: {(feeRate / 10).toFixed(1)}%
                    {selectedPaymentSource
                      ? ` (${selectedPaymentSource.network})`
                      : ' (default)'}
                  </p>
                );
              })()}
            </div>
            <Button
              onClick={() => setShowDownloadDialog(true)}
              disabled={filteredTransactions.length === 0}
              className="flex items-center gap-2"
            >
              <Download className="h-4 w-4" />
              Download CSV
            </Button>
          </div>
        </div>

        <div className="space-y-6">
          <Tabs
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={(tab) => {
              setActiveTab(tab);
            }}
          />

          <div className="flex items-center justify-between">
            <div className="relative flex-1">
              <Search className="h-4 w-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search by ID, hash, status, amount..."
                className="max-w-xs pl-10"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <RefreshButton
                onRefresh={() => refreshTransactions()}
                isRefreshing={isLoading}
              />
            </div>
          </div>

          <div className="border rounded-lg overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b">
                  <th className="p-4 text-left text-sm font-medium">
                    <Checkbox
                      checked={
                        filteredTransactions.length > 0 &&
                        selectedTransactions.length ===
                          filteredTransactions.length
                      }
                      onCheckedChange={handleSelectAll}
                    />
                  </th>
                  <th className="p-4 text-left text-sm font-medium">Type</th>
                  <th className="p-4 text-left text-sm font-medium">
                    Transaction Hash
                  </th>
                  <th className="p-4 text-left text-sm font-medium">Amount</th>
                  <th className="p-4 text-left text-sm font-medium">Network</th>
                  <th className="p-4 text-left text-sm font-medium">Status</th>
                  <th className="p-4 text-left text-sm font-medium">
                    Unlock Time
                  </th>
                  <th className="p-4 text-left text-sm font-medium">Date</th>
                  <th className="p-4 text-left text-sm font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {isInitialLoading ? (
                  <tr>
                    <td colSpan={9}>
                      <Spinner size={20} addContainer />
                    </td>
                  </tr>
                ) : filteredTransactions.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="text-center py-8">
                      No transactions found
                    </td>
                  </tr>
                ) : (
                  filteredTransactions.map((transaction) => (
                    <tr
                      key={transaction.id}
                      className={cn(
                        'border-b last:border-b-0',
                        transaction.NextAction?.errorType
                          ? 'bg-destructive/10'
                          : '',
                        'cursor-pointer hover:bg-muted/50',
                      )}
                      onClick={() => setSelectedTransaction(transaction)}
                    >
                      <td className="p-4" onClick={(e) => e.stopPropagation()}>
                        <Checkbox
                          checked={selectedTransactions.includes(
                            transaction.id,
                          )}
                          onCheckedChange={() =>
                            handleSelectTransaction(transaction.id)
                          }
                        />
                      </td>
                      <td className="p-4">
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
                            <CopyButton
                              value={transaction.CurrentTransaction?.txHash}
                            />
                          )}
                        </div>
                      </td>
                      <td className="p-4">
                        {transaction.type === 'payment' &&
                        transaction.RequestedFunds?.length
                          ? transaction.RequestedFunds.map((fund, index) => {
                              const amount = formatPrice(fund.amount);
                              const unit = formatFundUnit(
                                fund.unit,
                                state.network,
                              );
                              return (
                                <div key={index} className="text-sm">
                                  {amount} {unit}
                                </div>
                              );
                            })
                          : transaction.type === 'purchase' &&
                              transaction.PaidFunds?.length
                            ? transaction.PaidFunds.map((fund, index) => {
                                const amount = formatPrice(fund.amount);
                                const unit = formatFundUnit(
                                  fund.unit,
                                  state.network,
                                );
                                return (
                                  <div key={index} className="text-sm">
                                    {amount} {unit}
                                  </div>
                                );
                              })
                            : '—'}
                      </td>
                      <td className="p-4">
                        {transaction.PaymentSource.network}
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
                              <div className="w-2 h-2 bg-orange-500 rounded-full"></div>
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
                      <td className="p-4">
                        {new Date(transaction.createdAt).toLocaleString()}
                      </td>
                      <td className="p-4">
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          ⋮
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
              <Pagination
                hasMore={hasMore}
                isLoading={isLoadingMore}
                onLoadMore={handleLoadMore}
              />
            )}
          </div>
        </div>
      </div>

      <TransactionDetailsDialog
        transaction={selectedTransaction}
        onClose={() => setSelectedTransaction(null)}
        onRefresh={refreshTransactions}
        apiClient={apiClient}
        state={state}
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
    </MainLayout>
  );
}
