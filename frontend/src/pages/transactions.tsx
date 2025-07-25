/* eslint-disable @typescript-eslint/no-unused-vars, react-hooks/exhaustive-deps */
import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { cn, shortenAddress } from '@/lib/utils';
import { MainLayout } from '@/components/layout/MainLayout';
import Head from 'next/head';
import { useAppContext } from '@/lib/contexts/AppContext';
import {
  getPayment,
  GetPaymentResponses,
  getPurchase,
  GetPurchaseResponses,
  postPurchaseRequestRefund,
  postPurchaseCancelRefundRequest,
  postPaymentAuthorizeRefund,
} from '@/lib/api/generated';
import { toast } from 'react-toastify';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { Search } from 'lucide-react';
import { Tabs } from '@/components/ui/tabs';
import { Pagination } from '@/components/ui/pagination';
import { CopyButton } from '@/components/ui/copy-button';
import { parseError } from '@/lib/utils';

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

  const tabs = [
    { name: 'All', count: null },
    { name: 'Payments', count: null },
    { name: 'Purchases', count: null },
    { name: 'Refund Requests', count: null },
  ];

  const filterTransactions = useCallback(() => {
    const seenHashes = new Set();
    let filtered = [...allTransactions].filter((tx) => {
      const hash = tx.CurrentTransaction?.txHash;
      if (!hash) return true;
      if (seenHashes.has(hash)) return false;
      seenHashes.add(hash);
      return true;
    });

    if (activeTab === 'Payments') {
      filtered = filtered.filter((t) => t.type === 'payment');
    } else if (activeTab === 'Purchases') {
      filtered = filtered.filter((t) => t.type === 'purchase');
    } else if (activeTab === 'Refund Requests') {
      filtered = filtered.filter((t) => t.onChainState === 'RefundRequested');
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
    async (reset = false) => {
      try {
        if (reset) {
          setIsLoading(true);
          setAllTransactions([]);
          setPurchaseCursorId(null);
          setPaymentCursorId(null);
          setHasMorePurchases(true);
          setHasMorePayments(true);
        } else {
          setIsLoadingMore(true);
        }
        const selectedPaymentSource = state.paymentSources.find(
          (ps) => ps.id === selectedPaymentSourceId,
        );
        const smartContractAddress =
          selectedPaymentSource?.smartContractAddress;
        // Fetch purchases
        let purchases: Transaction[] = [];
        let newPurchaseCursor: string | null = purchaseCursorId;
        let morePurchases = hasMorePurchases;
        if (hasMorePurchases) {
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
        let morePayments = hasMorePayments;
        if (hasMorePayments) {
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
          ...(reset ? [] : allTransactions),
          ...purchases,
          ...payments,
        ];
        const seen = new Set();
        const deduped = combined.filter((tx) => {
          const key = `${tx.type}:${tx.CurrentTransaction?.txHash || tx.id}`;
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

  useEffect(() => {
    fetchTransactions(true);
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
      case 'refundwithdrawn':
        return 'text-orange-500';
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

  const clearTransactionError = async (transaction: Transaction) => {
    try {
      await apiClient.request({
        method: 'PUT',
        url: `/transactions/${transaction.id}/clear-error`,
      });
      toast.success('Error state cleared successfully');
      return true;
    } catch (error) {
      handleError(error as ApiError);
      return false;
    }
  };

  const updateTransactionState = async (
    transaction: Transaction,
    newState: string,
  ) => {
    try {
      await apiClient.request({
        method: 'PUT',
        url: `/transactions/${transaction.id}/state`,
        data: { state: newState },
      });
      toast.success('Transaction state updated successfully');
      return true;
    } catch (error) {
      handleError(error as ApiError);
      return false;
    }
  };

  const canRequestRefund = (transaction: Transaction) => {
    return (
      transaction.onChainState === 'ResultSubmitted' ||
      transaction.onChainState === 'FundsLocked'
    );
  };

  const canAllowRefund = (transaction: Transaction) => {
    return (
      transaction.onChainState === 'RefundRequested' ||
      transaction.onChainState === 'Disputed'
    );
  };

  const canCancelRefund = (transaction: Transaction) => {
    return (
      transaction.onChainState === 'RefundRequested' ||
      transaction.onChainState === 'Disputed'
    );
  };

  const handleRefundRequest = async (transaction: Transaction) => {
    try {
      const body = {
        blockchainIdentifier: transaction.blockchainIdentifier,
        network: state.network,
        smartContractAddress: transaction.PaymentSource.smartContractAddress,
      };
      const response = await postPurchaseRequestRefund({
        client: apiClient,
        data: { body },
      });
      if (
        response?.status &&
        response.status >= 200 &&
        response.status < 300 &&
        response.data?.data
      ) {
        toast.success('Refund request submitted successfully');
        fetchTransactions(true);
        setSelectedTransaction(null);
      } else {
        throw new Error('Refund request failed');
      }
    } catch (error) {
      console.error('Refund error:', error);
      toast.error(parseError(error));
    }
  };

  const handleAllowRefund = async (transaction: Transaction) => {
    try {
      const body = {
        blockchainIdentifier: transaction.blockchainIdentifier,
        network: state.network,
        paymentContractAddress: transaction.PaymentSource.smartContractAddress,
      };
      console.log('Allow refund body:', body);
      const response = await postPaymentAuthorizeRefund({
        client: apiClient,
        data: { body },
      });
      if (
        response?.data &&
        typeof response.data === 'object' &&
        'error' in response.data &&
        response.data.error &&
        typeof response.data.error === 'object' &&
        'message' in response.data.error &&
        typeof response.data.error.message === 'string'
      ) {
        throw {
          message: response.data.error.message,
          error: response.data.error,
        };
      }
      if (
        response?.status &&
        response.status >= 200 &&
        response.status < 300 &&
        response.data?.data
      ) {
        toast.success('Refund authorized successfully');
        fetchTransactions(true);
        setSelectedTransaction(null);
      } else {
        throw new Error('Refund authorization failed');
      }
    } catch (error) {
      console.error('Allow refund error:', error);
      toast.error(parseError(error));
    }
  };

  const handleCancelRefund = async (transaction: Transaction) => {
    try {
      const body = {
        blockchainIdentifier: transaction.blockchainIdentifier,
        network: state.network,
        smartContractAddress: transaction.PaymentSource.smartContractAddress,
      };
      console.log('Cancel refund body:', body);
      const response = await postPurchaseCancelRefundRequest({
        client: apiClient,
        data: { body },
      });
      console.log('Cancel refund response:', response);
      if (
        response?.status &&
        response.status >= 200 &&
        response.status < 300 &&
        response.data?.data
      ) {
        toast.success('Refund request cancelled successfully');
        fetchTransactions(true);
        setSelectedTransaction(null);
      } else {
        throw new Error('Refund cancel failed');
      }
    } catch (error) {
      console.error('Cancel refund error:', error);
      toast.error(parseError(error));
    }
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
                          {formatStatus(transaction.onChainState)}
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
                  activeTab === 'All' || activeTab === 'Refund Requests'
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

      <Dialog
        open={!!selectedTransaction}
        onOpenChange={() => setSelectedTransaction(null)}
      >
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Transaction Details</DialogTitle>
          </DialogHeader>
          {selectedTransaction && (
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div className="col-span-2">
                  <h4 className="font-semibold mb-1">Transaction ID</h4>
                  <div className="flex items-center gap-2 bg-muted/30 rounded-md p-2">
                    <p className="text-sm font-mono break-all">
                      {selectedTransaction.id}
                    </p>
                    <CopyButton value={selectedTransaction.id} />
                  </div>
                </div>

                <div className="col-span-2 my-4">
                  <h4 className="font-semibold mb-1">Network</h4>
                  <p className="text-sm capitalize">
                    {selectedTransaction.PaymentSource.network}
                  </p>
                </div>

                <div className="col-span-2 w-full mb-4">
                  <h4 className="font-semibold mb-1">Blockchain Identifier</h4>
                  <p className="text-sm font-mono break-all flex gap-2 items-center">
                    {shortenAddress(selectedTransaction.blockchainIdentifier)}
                    <CopyButton
                      value={selectedTransaction.blockchainIdentifier}
                    />
                  </p>
                </div>

                <div>
                  <h4 className="font-semibold mb-1">Type</h4>
                  <p className="text-sm capitalize">
                    {selectedTransaction.type}
                  </p>
                </div>
                <div>
                  <h4 className="font-semibold mb-1">Created</h4>
                  <p className="text-sm">
                    {new Date(selectedTransaction.createdAt).toLocaleString()}
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <h4 className="font-semibold">Onchain state</h4>
                <div className="rounded-md border p-4 bg-muted/10">
                  <p className="text-sm font-medium">
                    {(() => {
                      const state =
                        selectedTransaction.onChainState?.toLowerCase();
                      switch (state) {
                        case 'fundslocked':
                          return 'Funds Locked';
                        case 'resultsubmitted':
                          return 'Result Submitted';
                        case 'refundrequested':
                          return 'Refund Requested (waiting for approval)';
                        case 'refundwithdrawn':
                          return 'Refund Withdrawn';
                        case 'disputed':
                          return 'Disputed';
                        case 'disputedwithdrawn':
                          return 'Disputed Withdrawn';
                        case 'withdrawn':
                          return 'Withdrawn';
                        case 'fundsordatuminvalid':
                          return 'Funds or Datum Invalid';
                        case 'resultsubmitted':
                          return 'Result Submitted';
                        case 'refundrequested':
                          return 'Refund Requested (waiting for approval)';
                        case 'refundwithdrawn':
                        default:
                          return state
                            ? state.charAt(0).toUpperCase() + state.slice(1)
                            : '—';
                      }
                    })()}
                  </p>
                  {selectedTransaction.NextAction?.requestedAction && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Next action:{' '}
                      {(() => {
                        const action =
                          selectedTransaction.NextAction.requestedAction;
                        switch (action) {
                          case 'None':
                            return 'None';
                          case 'Ignore':
                            return 'Ignore';
                          case 'WaitingForManualAction':
                            return 'Waiting for manual action';
                          case 'WaitingForExternalAction':
                            return 'Waiting for external action';
                          case 'FundsLockingRequested':
                            return 'Funds locking requested';
                          case 'FundsLockingInitiated':
                            return 'Funds locking initiated';
                          case 'SetRefundRequestedRequested':
                            return 'Refund request initiated';
                          case 'SetRefundRequestedInitiated':
                            return 'Refund request in progress';
                          case 'WithdrawRequested':
                            return 'Withdraw requested';
                          case 'WithdrawInitiated':
                            return 'Withdraw initiated';
                          case 'WithdrawRefundRequested':
                            return 'Refund withdraw requested';
                          case 'WithdrawRefundInitiated':
                            return 'Refund withdraw initiated';
                          default:
                            return action;
                        }
                      })()}
                    </p>
                  )}
                </div>
              </div>

              <div className="space-y-2">
                <h4 className="font-semibold">Transaction Details</h4>
                <div className="grid grid-cols-2 gap-4 rounded-md border p-4 bg-muted/10">
                  <div>
                    <h5 className="text-sm font-medium mb-1">Status</h5>
                    <p
                      className={cn(
                        'text-sm',
                        getStatusColor(
                          selectedTransaction.onChainState,
                          !!selectedTransaction.NextAction?.errorType,
                        ),
                      )}
                    >
                      {formatStatus(selectedTransaction.onChainState)}
                    </p>
                  </div>

                  <div>
                    <h5 className="text-sm font-medium mb-1">Amount</h5>
                    <p className="text-sm">
                      {selectedTransaction.type === 'payment' &&
                      selectedTransaction.RequestedFunds?.[0]
                        ? `${(parseInt(selectedTransaction.RequestedFunds[0].amount) / 1000000).toFixed(2)} ₳`
                        : selectedTransaction.type === 'purchase' &&
                            selectedTransaction.PaidFunds?.[0]
                          ? `${(parseInt(selectedTransaction.PaidFunds[0].amount) / 1000000).toFixed(2)} ₳`
                          : '—'}
                    </p>
                  </div>

                  <div className="col-span-2">
                    <h5 className="text-sm font-medium mb-1">
                      Transaction Hash
                    </h5>
                    {selectedTransaction.CurrentTransaction?.txHash ? (
                      <div className="flex items-center gap-2 bg-muted/30 rounded-md p-2">
                        <p className="text-sm font-mono break-all">
                          {selectedTransaction.CurrentTransaction.txHash}
                        </p>
                        <CopyButton
                          value={selectedTransaction.CurrentTransaction?.txHash}
                        />
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        No transaction hash available
                      </p>
                    )}
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <h4 className="font-semibold">Time Information</h4>
                <div className="grid grid-cols-2 gap-4 rounded-md border p-4 bg-muted/10">
                  <div>
                    <h5 className="text-sm font-medium mb-1">Created</h5>
                    <p className="text-sm">
                      {formatTimestamp(selectedTransaction.createdAt)}
                    </p>
                  </div>
                  <div>
                    <h5 className="text-sm font-medium mb-1">Last Updated</h5>
                    <p className="text-sm">
                      {formatTimestamp(selectedTransaction.updatedAt)}
                    </p>
                  </div>
                  <div>
                    <h5 className="text-sm font-medium mb-1">
                      Submit Result By
                    </h5>
                    <p className="text-sm">
                      {formatTimestamp(selectedTransaction.submitResultTime)}
                    </p>
                  </div>
                  <div>
                    <h5 className="text-sm font-medium mb-1">Unlock Time</h5>
                    <p className="text-sm">
                      {formatTimestamp(selectedTransaction.unlockTime)}
                    </p>
                  </div>
                  <div>
                    <h5 className="text-sm font-medium mb-1">
                      External Dispute Unlock Time
                    </h5>
                    <p className="text-sm">
                      {formatTimestamp(
                        selectedTransaction.externalDisputeUnlockTime,
                      )}
                    </p>
                  </div>
                  <div>
                    <h5 className="text-sm font-medium mb-1">Last Checked</h5>
                    <p className="text-sm">
                      {formatTimestamp(selectedTransaction.lastCheckedAt)}
                    </p>
                  </div>
                </div>
              </div>

              {selectedTransaction.type === 'payment' &&
                selectedTransaction.SmartContractWallet && (
                  <div className="space-y-2">
                    <h4 className="font-semibold">Wallet Information</h4>
                    <div className="grid grid-cols-1 gap-4 rounded-md border p-4">
                      <div>
                        <h5 className="text-sm font-medium mb-1">
                          Collection Wallet
                        </h5>
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-mono break-all">
                            {
                              selectedTransaction.SmartContractWallet
                                .walletAddress
                            }
                          </p>
                          <CopyButton
                            value={
                              selectedTransaction.SmartContractWallet
                                ?.walletAddress
                            }
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                )}

              {selectedTransaction.NextAction?.errorType && (
                <div className="space-y-2">
                  <h4 className="font-semibold">Error Details</h4>
                  <div className="space-y-2 rounded-md bg-destructive/20 p-4">
                    <div className="space-y-1">
                      <p className="text-sm">
                        <span className="font-medium">Error Type:</span>{' '}
                        {selectedTransaction.NextAction.errorType}
                      </p>
                      {selectedTransaction.NextAction.errorNote && (
                        <p className="text-sm">
                          <span className="font-medium">Error Note:</span>{' '}
                          {selectedTransaction.NextAction.errorNote}
                        </p>
                      )}
                      <div className="flex gap-2 mt-4">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={async () => {
                            if (
                              await clearTransactionError(selectedTransaction)
                            ) {
                              setSelectedTransaction(null);
                              fetchTransactions(true);
                            }
                          }}
                        >
                          Clear Error State
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={async () => {
                            const newState = prompt('Enter new state:');
                            if (
                              newState &&
                              (await updateTransactionState(
                                selectedTransaction,
                                newState,
                              ))
                            ) {
                              setSelectedTransaction(null);
                              fetchTransactions(true);
                            }
                          }}
                        >
                          Set New State
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex gap-2 justify-end">
                {canRequestRefund(selectedTransaction) &&
                  selectedTransaction.type === 'purchase' && (
                    <Button
                      variant="secondary"
                      onClick={() => handleRefundRequest(selectedTransaction)}
                    >
                      Request Refund
                    </Button>
                  )}
                {canAllowRefund(selectedTransaction) &&
                  selectedTransaction.type === 'payment' && (
                    <Button
                      variant="secondary"
                      onClick={() => handleAllowRefund(selectedTransaction)}
                    >
                      Allow Refund
                    </Button>
                  )}
                {canCancelRefund(selectedTransaction) &&
                  selectedTransaction.type === 'purchase' && (
                    <Button
                      variant="destructive"
                      onClick={() => handleCancelRefund(selectedTransaction)}
                    >
                      Cancel Refund Request
                    </Button>
                  )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </MainLayout>
  );
}
