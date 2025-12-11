/* eslint-disable @typescript-eslint/no-unused-vars, react-hooks/exhaustive-deps */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { cn, shortenAddress } from '@/lib/utils';
import { MainLayout } from '@/components/layout/MainLayout';
import { RefreshButton } from '@/components/RefreshButton';
import Head from 'next/head';
import { useAppContext } from '@/lib/contexts/AppContext';
import {
  getPayment,
  GetPaymentResponses,
  getPurchase,
  GetPurchaseResponses,
} from '@/lib/api/generated';
import { toast } from 'react-toastify';
import { Spinner } from '@/components/ui/spinner';
import { Search } from 'lucide-react';
import { Tabs } from '@/components/ui/tabs';
import { Pagination } from '@/components/ui/pagination';
import { CopyButton } from '@/components/ui/copy-button';
import { parseError } from '@/lib/utils';
import { TESTUSDM_CONFIG, getUsdmConfig } from '@/lib/constants/defaultWallets';
import TransactionDetailsDialog from '@/components/transactions/TransactionDetailsDialog';
import { DownloadDetailsDialog } from '@/components/transactions/DownloadDetailsDialog';
import { Download } from 'lucide-react';
import { dateRangeUtils } from '@/lib/utils';

type Transaction =
  | (GetPaymentResponses['200']['data']['Payments'][0] & { type: 'payment' })
  | (GetPurchaseResponses['200']['data']['Purchases'][0] & {
      type: 'purchase';
    });

interface ApiError {
  message: string;
  error?: {
    message?: string;
  };
}

const handleError = (error: ApiError) => {
  const errorMessage =
    error.error?.message || error.message || 'An error occurred';
  toast.error(errorMessage);
};

const formatTimestamp = (timestamp: string | null | undefined): string => {
  if (!timestamp) return '—';

  if (/^\d+$/.test(timestamp)) {
    return new Date(parseInt(timestamp)).toLocaleString();
  }

  return new Date(timestamp).toLocaleString();
};

export default function Transactions() {
  const { apiClient, state, selectedPaymentSourceId } = useAppContext();

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

  // Format fund unit display helper function
  const formatFundUnit = (
    unit: string | undefined,
    network: string | undefined,
  ): string => {
    if (!network) {
      // If no network, fallback to basic unit formatting
      if (unit === 'lovelace' || !unit) {
        return 'ADA';
      }
      return unit;
    }

    if (!unit) {
      return 'ADA';
    }

    const usdmConfig = getUsdmConfig(network);
    const isUsdm =
      unit === usdmConfig.fullAssetId ||
      unit === usdmConfig.policyId ||
      unit === 'USDM' ||
      unit === 'tUSDM';

    if (isUsdm) {
      return network.toLowerCase() === 'preprod' ? 'tUSDM' : 'USDM';
    }

    const isTestUsdm = unit === TESTUSDM_CONFIG.unit;
    if (isTestUsdm) {
      return 'tUSDM';
    }
    return unit ?? '—';
  };
  const [activeTab, setActiveTab] = useState('All');
  const [selectedTransactions, setSelectedTransactions] = useState<string[]>(
    [],
  );
  const [allTransactions, setAllTransactions] = useState<Transaction[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTransaction, setSelectedTransaction] =
    useState<Transaction | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [purchaseCursorId, setPurchaseCursorId] = useState<string | null>(null);
  const [paymentCursorId, setPaymentCursorId] = useState<string | null>(null);
  const [hasMorePurchases, setHasMorePurchases] = useState(true);
  const [hasMorePayments, setHasMorePayments] = useState(true);
  const [showDownloadDialog, setShowDownloadDialog] = useState(false);
  const tabsRef = useRef<(HTMLButtonElement | null)[]>([]);

  const tabs = [
    { name: 'All', count: null },
    { name: 'Payments', count: null },
    { name: 'Purchases', count: null },
    { name: 'Refund Requests', count: null },
    { name: 'Disputes', count: null },
  ];

  const fetchTransactions = useCallback(
    async (
      forceFetchPurchases = false,
      forceFetchPayments = false,
      resetCursor = false,
    ) => {
      try {
        setIsLoadingMore(true);
        const selectedPaymentSource = state.paymentSources.find(
          (ps) => ps.id === selectedPaymentSourceId,
        );
        const smartContractAddress =
          selectedPaymentSource?.smartContractAddress;

        // Determine which endpoints to fetch based on activeTab
        const shouldFetchPurchases =
          activeTab === 'All' ||
          activeTab === 'Purchases' ||
          activeTab === 'Refund Requests' ||
          activeTab === 'Disputes';
        const shouldFetchPayments =
          activeTab === 'All' ||
          activeTab === 'Payments' ||
          activeTab === 'Refund Requests' ||
          activeTab === 'Disputes';

        // Map tab to filterOnChainState
        const filterOnChainState =
          activeTab === 'Refund Requests'
            ? 'RefundRequests'
            : activeTab === 'Disputes'
              ? 'Disputes'
              : undefined;

        // Fetch purchases
        let purchases: Transaction[] = [];
        let newPurchaseCursor: string | null = purchaseCursorId;
        let morePurchases = (forceFetchPurchases || hasMorePurchases) && shouldFetchPurchases;
        if (morePurchases) {
          const purchaseRes = await getPurchase({
            client: apiClient,
            query: {
              network: state.network,
              cursorId: resetCursor ? undefined : purchaseCursorId || undefined,
              includeHistory: 'true',
              limit: 10,
              filterSmartContractAddress: smartContractAddress
                ? smartContractAddress
                : undefined,
              filterOnChainState: filterOnChainState,
              searchQuery: searchQuery || undefined,
            },
          });
          if (purchaseRes.data?.data?.Purchases) {
            purchases = purchaseRes.data.data.Purchases.map((purchase) => ({
              ...purchase,
              type: 'purchase',
            }));
            if (purchases.length > 0) {
              newPurchaseCursor = purchases[purchases.length - 1].id;
            }
            morePurchases = purchases.length === 10;
          } else {
            morePurchases = false;
          }
        }

        // Fetch payments
        let payments: Transaction[] = [];
        let newPaymentCursor: string | null = paymentCursorId;
        let morePayments = (forceFetchPayments || hasMorePayments) && shouldFetchPayments;
        if (morePayments) {
          const paymentRes = await getPayment({
            client: apiClient,
            query: {
              network: state.network,
              cursorId: resetCursor ? undefined : paymentCursorId || undefined,
              includeHistory: 'true',
              limit: 10,
              filterSmartContractAddress: smartContractAddress
                ? smartContractAddress
                : undefined,
              filterOnChainState: filterOnChainState,
              searchQuery: searchQuery || undefined,
            },
          });
          if (paymentRes.data?.data?.Payments) {
            payments = paymentRes.data.data.Payments.map((payment) => ({
              ...payment,
              type: 'payment',
            }));
            if (payments.length > 0) {
              newPaymentCursor = payments[payments.length - 1].id;
            }
            morePayments = payments.length === 10;
          } else {
            morePayments = false;
          }
        }

        // Combine and dedupe by type+hash
        const combined = [
          ...purchases,
          ...payments,
          //fixes ordering for updates
          ...allTransactions,
        ];
        const seen = new Set();
        const deduped = combined.filter((tx) => {
          const key = tx.id;
          if (!key) return true;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        // Sort by createdAt
        const sorted = deduped.sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
        setAllTransactions(sorted);
        setPurchaseCursorId(newPurchaseCursor);
        setPaymentCursorId(newPaymentCursor);
        setHasMorePurchases(morePurchases);
        setHasMorePayments(morePayments);
      } catch (error) {
        console.error('Failed to fetch transactions:', error);
        toast.error('Failed to load transactions');
      } finally {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    },
    [
      selectedPaymentSourceId,
      apiClient,
      state.network,
      purchaseCursorId,
      paymentCursorId,
      hasMorePurchases,
      hasMorePayments,
      allTransactions,
      activeTab,
      searchQuery,
    ],
  );

  const refreshTransactions = () => {
    setPurchaseCursorId(null);
    setPaymentCursorId(null);
    setHasMorePurchases(true);
    setHasMorePayments(true);
    setIsLoading(true);
    setAllTransactions([]);
    // Force fetch both purchases and payments

    fetchTransactions(true, true, true);
  };

  useEffect(() => {
    fetchTransactions();
    // Set last visit timestamp when user visits transactions page
    if (typeof window !== 'undefined') {
      localStorage.setItem(
        'masumi_last_transactions_visit',
        new Date().toISOString(),
      );
      localStorage.setItem('masumi_new_transactions_count', '0');
    }
  }, [state.network, apiClient, selectedPaymentSourceId, activeTab, searchQuery]);

  const handleLoadMore = () => {
    if (!isLoadingMore && (hasMorePurchases || hasMorePayments)) {
      fetchTransactions();
    }
  };

  const handleSelectTransaction = (id: string) => {
    setSelectedTransactions((prev) =>
      prev.includes(id)
        ? prev.filter((transactionId) => transactionId !== id)
        : [...prev, id],
    );
  };

  const handleSelectAll = () => {
    if (allTransactions.length === selectedTransactions.length) {
      setSelectedTransactions([]);
    } else {
      setSelectedTransactions(allTransactions.map((t) => t.id));
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
              setPurchaseCursorId(null);
              setPaymentCursorId(null);
              setHasMorePurchases(true);
              setHasMorePayments(true);
              setAllTransactions([]);
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
                        allTransactions.length > 0 &&
                        selectedTransactions.length === allTransactions.length
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
                {isLoading ? (
                  <tr>
                    <td colSpan={9}>
                      <Spinner size={20} addContainer />
                    </td>
                  </tr>
                ) : allTransactions.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="text-center py-8">
                      No transactions found
                    </td>
                  </tr>
                ) : (
                  allTransactions.map((transaction) => (
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
            {!isLoading && (
              <Pagination
                hasMore={
                  activeTab === 'All' ||
                  activeTab === 'Refund Requests' ||
                  activeTab === 'Disputes'
                    ? hasMorePurchases || hasMorePayments
                    : activeTab === 'Payments'
                      ? hasMorePayments
                      : hasMorePurchases
                }
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
        onRefresh={() => fetchTransactions()}
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
