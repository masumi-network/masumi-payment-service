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
import TransactionDetailsDialog from '@/components/transactions/TransactionDetailsDialog';

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
  const [activeTab, setActiveTab] = useState('All');
  const [selectedTransactions, setSelectedTransactions] = useState<string[]>(
    [],
  );
  const [allTransactions, setAllTransactions] = useState<Transaction[]>([]);
  const [filteredTransactions, setFilteredTransactions] = useState<
    Transaction[]
  >([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTransaction, setSelectedTransaction] =
    useState<Transaction | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [purchaseCursorId, setPurchaseCursorId] = useState<string | null>(null);
  const [paymentCursorId, setPaymentCursorId] = useState<string | null>(null);
  const [hasMorePurchases, setHasMorePurchases] = useState(true);
  const [hasMorePayments, setHasMorePayments] = useState(true);
  const tabsRef = useRef<(HTMLButtonElement | null)[]>([]);

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

  const fetchTransactions = useCallback(
    async (forceFetchPurchases = false, forceFetchPayments = false) => {
      try {
          setIsLoadingMore(true);
        const selectedPaymentSource = state.paymentSources.find(
          (ps) => ps.id === selectedPaymentSourceId,
        );
        const smartContractAddress =
          selectedPaymentSource?.smartContractAddress;
        // Fetch purchases
        let purchases: Transaction[] = [];
        let newPurchaseCursor: string | null = purchaseCursorId;
        let morePurchases = forceFetchPurchases || hasMorePurchases;
        if (morePurchases) {
          const purchaseRes = await getPurchase({
            client: apiClient,
            query: {
              network: state.network,
              cursorId: purchaseCursorId || undefined,
              includeHistory: 'true',
              limit: 10,
              filterSmartContractAddress: smartContractAddress
                ? smartContractAddress
                : undefined,
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
        let morePayments = forceFetchPayments || hasMorePayments;
        if (morePayments) {
          const paymentRes = await getPayment({
            client: apiClient,
            query: {
              network: state.network,
              cursorId: paymentCursorId || undefined,
              includeHistory: 'true',
              limit: 10,
              filterSmartContractAddress: smartContractAddress
                ? smartContractAddress
                : undefined,
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
    fetchTransactions(true, true);
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
  }, [state.network, apiClient, selectedPaymentSourceId]);

  useEffect(() => {
    filterTransactions();
  }, [filterTransactions, searchQuery, activeTab]);

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

  return (
    <MainLayout>
      <Head>
        <title>Transactions | Admin Interface</title>
      </Head>
      <div>
        <div className="mb-6">
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
        </div>

        <div className="space-y-6">
          <Tabs
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={(tab) => {
              setActiveTab(tab);
              //setAllTransactions([]);
              //fetchTransactions();
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
                  <th className="p-4 text-left text-sm font-medium">Date</th>
                  <th className="p-4 text-left text-sm font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  <tr>
                    <td colSpan={8}>
                      <Spinner size={20} addContainer />
                    </td>
                  </tr>
                ) : filteredTransactions.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-center py-8">
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
                        transaction.RequestedFunds?.[0]
                          ? `${(parseInt(transaction.RequestedFunds[0].amount) / 1000000).toFixed(2)} ₳`
                          : transaction.type === 'purchase' &&
                              transaction.PaidFunds?.[0]
                            ? `${(parseInt(transaction.PaidFunds[0].amount) / 1000000).toFixed(2)} ₳`
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
    </MainLayout>
  );
}
