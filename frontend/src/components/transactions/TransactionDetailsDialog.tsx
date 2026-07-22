import React, { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { cn, shortenAddress, getExplorerUrl, formatAssetAmount } from '@/lib/utils';
import { formatDateTime } from '@/lib/format-date';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { CopyButton } from '@/components/ui/copy-button';
import { WalletLink } from '@/components/ui/wallet-link';
import { toast } from 'react-toastify';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  postPurchaseRequestRefund,
  postPurchaseCancelRefundRequest,
  postPaymentAuthorizeRefund,
  postPurchaseErrorStateRecovery,
  postPaymentErrorStateRecovery,
  getRegistryAgentIdentifier,
} from '@/lib/api/generated';
import { useAppContext } from '@/lib/contexts/AppContext';
import { WalletDetailsDialog, WalletWithBalance } from '@/components/wallets/WalletDetailsDialog';
import { useWalletsByVkeys } from '@/lib/queries/useWallets';
import { toPaymentSourceWalletDetails } from '@/lib/wallet-lookup';
import { extractApiErrorMessage } from '@/lib/api-error';
import { PaymentSourceTypeBadge } from '@/components/payment-sources/PaymentSourceTypeBadge';
import { useRegistryEntryByAgentIdentifier } from '@/lib/queries/useRegistryEntryByAgentIdentifier';
import { useAgentDetailsDialog } from '@/lib/contexts/AgentDetailsDialogContext';
import { TransactionHistorySection } from './TransactionHistorySection';
import { TransactionErrorSection } from './TransactionErrorSection';
import { RequestRepairDialog } from './RequestRepairDialog';
import {
  formatOnChainState,
  formatRequestedAction,
  formatStatus,
  getLatestTxHash,
  getStatusColor,
  type Transaction,
} from './transaction-format.helpers';

interface TransactionDetailsDialogProps {
  transaction: Transaction | null;
  onClose: () => void;
  onRefresh: () => void;
}

const handleError = (error: unknown, fallback: string = 'An error occurred') => {
  toast.error(extractApiErrorMessage(error, fallback));
};

const canRequestRefund = (transaction: Transaction) => {
  return (
    (transaction.onChainState === 'ResultSubmitted' ||
      transaction.onChainState === 'FundsLocked') &&
    transaction.NextAction?.requestedAction === 'WaitingForExternalAction'
  );
};

const canAllowRefund = (transaction: Transaction) => {
  return (
    transaction.onChainState === 'Disputed' &&
    transaction.NextAction?.requestedAction === 'WaitingForExternalAction'
  );
};

const canCancelRefund = (transaction: Transaction) => {
  return (
    transaction.onChainState === 'RefundRequested' &&
    transaction.NextAction?.requestedAction === 'WaitingForExternalAction'
  );
};

export default function TransactionDetailsDialog({
  transaction,
  onClose,
  onRefresh,
}: TransactionDetailsDialogProps) {
  const { network, apiClient } = useAppContext();
  const { openAgentDetails } = useAgentDetailsDialog();
  // Pin actions and explorer links to the network the transaction row lives
  // on, not the ambient app network (they can diverge mid-navigation).
  const transactionNetwork = transaction?.PaymentSource?.network ?? network;
  const [showConfirmDialog, setShowConfirmDialog] = React.useState(false);
  const [confirmAction, setConfirmAction] = React.useState<'refund' | 'cancel' | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [errorRecoveryMode, setErrorRecoveryMode] = React.useState<'clear' | 'retry' | null>(null);
  const [showRepairDialog, setShowRepairDialog] = useState(false);
  const [selectedWalletForDetails, setSelectedWalletForDetails] =
    useState<WalletWithBalance | null>(null);

  // Wallet parties resolved straight off the transaction (vkeys + any address
  // the transaction already carries). Addresses missing here are resolved
  // lazily by vkey via the dedicated endpoint, not by scanning loaded wallets.
  const rawWalletInfo = useMemo(() => {
    if (!transaction) return null;

    const smartContractAddress = transaction.PaymentSource?.smartContractAddress ?? null;

    let sellerVkey: string | null = null;
    let sellerAddress: string | null = null;
    let buyerVkey: string | null = null;
    let buyerAddress: string | null = null;

    if (transaction.type === 'payment') {
      // Payment: SmartContractWallet = seller, BuyerWallet = buyer
      sellerVkey = transaction.SmartContractWallet?.walletVkey ?? null;
      sellerAddress = transaction.SmartContractWallet?.walletAddress ?? null;
      buyerVkey = transaction.BuyerWallet?.walletVkey ?? null;
    } else {
      // Purchase: SmartContractWallet = buyer, SellerWallet = seller
      buyerVkey = transaction.SmartContractWallet?.walletVkey ?? null;
      buyerAddress = transaction.SmartContractWallet?.walletAddress ?? null;
      sellerVkey = transaction.SellerWallet?.walletVkey ?? null;
    }

    return { smartContractAddress, sellerVkey, sellerAddress, buyerVkey, buyerAddress };
  }, [transaction]);

  const walletByVkey = useWalletsByVkeys([rawWalletInfo?.sellerVkey, rawWalletInfo?.buyerVkey]);

  const isInternalWallet = useCallback(
    (walletVkey: string) => walletByVkey.has(walletVkey),
    [walletByVkey],
  );

  const handleWalletClick = useCallback(
    (walletVkey: string) => {
      const found = walletByVkey.get(walletVkey);
      if (!found) return;
      setSelectedWalletForDetails(toPaymentSourceWalletDetails(found));
    },
    [walletByVkey],
  );

  const walletInfo = useMemo(() => {
    if (!rawWalletInfo) return null;

    const sellerAddress =
      rawWalletInfo.sellerAddress ??
      (rawWalletInfo.sellerVkey
        ? (walletByVkey.get(rawWalletInfo.sellerVkey)?.walletAddress ?? null)
        : null);
    const buyerAddress =
      rawWalletInfo.buyerAddress ??
      (rawWalletInfo.buyerVkey
        ? (walletByVkey.get(rawWalletInfo.buyerVkey)?.walletAddress ?? null)
        : null);

    return { ...rawWalletInfo, sellerAddress, buyerAddress };
  }, [rawWalletInfo, walletByVkey]);

  const agentIdentifier = transaction?.agentIdentifier;
  const agentNetwork = transaction?.PaymentSource?.network;
  const agentPaymentSourceSc = transaction?.PaymentSource?.smartContractAddress ?? null;

  const registryEntryHookEnabled = Boolean(agentIdentifier && agentPaymentSourceSc);

  const {
    data: registryAgentForLink,
    isFetching: registryAgentLinkLoading,
    isFetched: registryLinkFetched,
  } = useRegistryEntryByAgentIdentifier({
    agentIdentifier,
    smartContractAddress: agentPaymentSourceSc,
    network: agentNetwork,
    enabled: registryEntryHookEnabled,
  });

  /** Prefer DB registry list (`getRegistry` via hook); chain lookup only when no scoped registry row (or hook off). */
  const chainAgentNameLookupEnabled = Boolean(
    agentIdentifier &&
    agentNetwork &&
    (!registryEntryHookEnabled || (registryLinkFetched && registryAgentForLink == null)),
  );

  const { data: agentNameFromChain, isFetching: chainAgentNameLoading } = useQuery({
    queryKey: ['registry-agent-identifier', agentIdentifier, agentNetwork],
    queryFn: async () => {
      if (!agentIdentifier || !agentNetwork) return null;
      const response = await getRegistryAgentIdentifier({
        client: apiClient,
        query: { agentIdentifier, network: agentNetwork },
      });
      return response.data?.data?.Metadata?.name ?? null;
    },
    enabled: chainAgentNameLookupEnabled,
    staleTime: 60_000,
  });

  const resolvedAgentName = registryAgentForLink?.name ?? agentNameFromChain ?? null;
  const agentNameLoading =
    registryAgentLinkLoading || (chainAgentNameLookupEnabled && chainAgentNameLoading);
  const recoverTransactionError = async (retryPreviousAction: boolean) => {
    try {
      setIsLoading(true);
      setErrorRecoveryMode(retryPreviousAction ? 'retry' : 'clear');

      if (!transaction) {
        toast.error('Transaction not found');
        return false;
      }
      if (!transaction.onChainState) {
        toast.error(
          'Transaction is in its initial on-chain state. Can not be recovered. Please start a new purchase request.',
        );
        return false;
      }
      if (transaction.type === 'purchase') {
        const response = await postPurchaseErrorStateRecovery({
          client: apiClient,
          body: {
            blockchainIdentifier: transaction.blockchainIdentifier,
            updatedAt: new Date(transaction.updatedAt),
            network: transactionNetwork,
            retryPreviousAction,
          },
        });
        if (response.error) {
          handleError(
            response.error,
            retryPreviousAction ? 'Failed to retry previous action' : 'Failed to clear error state',
          );
          return false;
        }
        toast.success(
          retryPreviousAction
            ? 'Previous action queued for retry'
            : 'Error state cleared successfully',
        );
        onRefresh();
        onClose();
        return true;
      }
      if (transaction.type === 'payment') {
        const response = await postPaymentErrorStateRecovery({
          client: apiClient,
          body: {
            blockchainIdentifier: transaction.blockchainIdentifier,
            updatedAt: new Date(transaction.updatedAt),
            network: transactionNetwork,
            retryPreviousAction,
          },
        });
        if (response.error) {
          handleError(
            response.error,
            retryPreviousAction ? 'Failed to retry previous action' : 'Failed to clear error state',
          );
          return false;
        }
        toast.success(
          retryPreviousAction
            ? 'Previous action queued for retry'
            : 'Error state cleared successfully',
        );
        onRefresh();
        onClose();
        return true;
      }

      return false;
    } catch (error) {
      handleError(error);
      return false;
    } finally {
      setIsLoading(false);
      setErrorRecoveryMode(null);
    }
  };

  const handleRefundRequest = async (transaction: Transaction) => {
    setIsLoading(true);
    try {
      const body = {
        blockchainIdentifier: transaction.blockchainIdentifier,
        network: transactionNetwork,
      };
      const response = await postPurchaseRequestRefund({
        client: apiClient,
        body,
      });

      if (response.error) {
        handleError(response.error, 'Refund request failed');
        return;
      }

      if (response.data?.data) {
        toast.success('Refund request submitted successfully');
        onRefresh();
        onClose();
      } else {
        throw new Error('Refund request failed');
      }
    } catch (error) {
      console.error('Refund error:', error);
      handleError(error, 'Refund request failed');
    } finally {
      setIsLoading(false);
    }
  };

  const handleAllowRefund = async (transaction: Transaction) => {
    try {
      const body = {
        blockchainIdentifier: transaction.blockchainIdentifier,
        network: transactionNetwork,
      };
      const response = await postPaymentAuthorizeRefund({
        client: apiClient,
        body,
      });

      if (response.error) {
        handleError(response.error, 'Refund authorization failed');
        return;
      }

      if (response.data?.data) {
        toast.success('Refund authorized successfully');
        onRefresh();
        onClose();
      } else {
        throw new Error('Refund authorization failed');
      }
    } catch (error) {
      console.error('Allow refund error:', error);
      handleError(error, 'Refund authorization failed');
    }
  };

  const handleCancelRefund = async (transaction: Transaction) => {
    try {
      const body = {
        blockchainIdentifier: transaction.blockchainIdentifier,
        network: transactionNetwork,
      };
      const response = await postPurchaseCancelRefundRequest({
        client: apiClient,
        body,
      });

      if (response.error) {
        handleError(response.error, 'Refund cancel failed');
        return;
      }

      if (response.data?.data) {
        toast.success('Refund request cancelled successfully');
        onRefresh();
        onClose();
      } else {
        throw new Error('Refund cancel failed');
      }
    } catch (error) {
      console.error('Cancel refund error:', error);
      handleError(error, 'Refund cancel failed');
    }
  };

  if (!transaction) return null;

  return (
    <>
      <Dialog
        open={!!transaction && !showConfirmDialog && !showRepairDialog}
        onOpenChange={onClose}
      >
        <DialogContent size="md" isPushedBack={!!selectedWalletForDetails}>
          <DialogHeader>
            <DialogTitle>Transaction Details</DialogTitle>
          </DialogHeader>
          <div className="space-y-6 w-full">
            <div className="grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <h4 className="font-semibold mb-1">Transaction ID</h4>
                <div className="flex items-center gap-2 bg-muted/30 rounded-md p-2">
                  <p className="text-sm font-mono break-all">{transaction.id}</p>
                  <CopyButton value={transaction.id} />
                </div>
              </div>

              <div>
                <h4 className="font-semibold mb-1">Source</h4>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm capitalize">{transaction.PaymentSource.network}</p>
                  <PaymentSourceTypeBadge
                    paymentSourceType={transaction.PaymentSource.paymentSourceType}
                    showDefault
                  />
                </div>
              </div>

              <div className="col-span-1 w-full mb-4">
                <h4 className="font-semibold mb-1">Blockchain Identifier</h4>
                <div className="text-sm font-mono break-all flex gap-2 items-center">
                  <span>{shortenAddress(transaction.blockchainIdentifier)}</span>
                  <CopyButton value={transaction.blockchainIdentifier} />
                </div>
              </div>

              {transaction.agentIdentifier ? (
                <div>
                  <h4 className="font-semibold mb-1">Agent Name</h4>
                  {agentNameLoading ? (
                    <Skeleton className="h-5 w-32" />
                  ) : resolvedAgentName ? (
                    <p className="text-sm">{resolvedAgentName}</p>
                  ) : (
                    <p className="text-sm text-muted-foreground">Not available</p>
                  )}
                </div>
              ) : (
                <div />
              )}
              {transaction.agentIdentifier ? (
                <div>
                  <h4 className="font-semibold mb-1">Agent Identifier</h4>
                  <div className="text-sm font-mono break-all flex gap-2 items-center flex-wrap">
                    {registryAgentLinkLoading ? (
                      <Skeleton className="h-5 w-40" />
                    ) : registryAgentForLink ? (
                      <button
                        type="button"
                        className="font-mono text-primary hover:underline text-left"
                        onClick={() =>
                          openAgentDetails(registryAgentForLink, { stackOverParentModal: true })
                        }
                      >
                        {shortenAddress(transaction.agentIdentifier)}
                      </button>
                    ) : (
                      <span>{shortenAddress(transaction.agentIdentifier)}</span>
                    )}
                    <CopyButton value={transaction.agentIdentifier} />
                  </div>
                </div>
              ) : (
                <div />
              )}

              <div>
                <h4 className="font-semibold mb-1">Type</h4>
                <p className="text-sm capitalize">{transaction.type}</p>
              </div>
              <div>
                <h4 className="font-semibold mb-1">Created</h4>
                <p className="text-sm">{formatDateTime(transaction.createdAt)}</p>
              </div>
            </div>

            {transaction.onChainState === 'Disputed' && (
              <div className="rounded-md border p-4 bg-orange-50 border-orange-200 dark:bg-orange-950/20 dark:border-orange-800">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-2 h-2 bg-orange-500 rounded-full"></div>
                  <h4 className="font-semibold text-orange-800 dark:text-orange-200">
                    Dispute Active
                  </h4>
                </div>
                <p className="text-sm text-orange-700 dark:text-orange-300">
                  This payment is in dispute. As the seller, you can authorize a refund to resolve
                  the dispute.
                </p>
              </div>
            )}

            <div className="space-y-2">
              <h4 className="font-semibold">Onchain state</h4>
              <div className="rounded-md border p-4 bg-muted/10">
                <p className="text-sm font-medium">
                  {formatOnChainState(transaction.onChainState)}
                </p>
                {transaction.NextAction?.requestedAction && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Next action: {formatRequestedAction(transaction.NextAction.requestedAction)}
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
                      getStatusColor(transaction.onChainState, !!transaction.NextAction?.errorType),
                    )}
                  >
                    {formatStatus(transaction.onChainState)}
                  </p>
                </div>

                <div>
                  <h5 className="text-sm font-medium mb-1">Amount</h5>
                  <div className="text-sm">
                    {transaction.type === 'payment' &&
                    transaction.RequestedFunds &&
                    transaction.RequestedFunds.length > 0 ? (
                      transaction.RequestedFunds.map((fund, index) => (
                        <p key={index}>
                          {formatAssetAmount(fund.amount, fund.unit, transactionNetwork)}
                        </p>
                      ))
                    ) : transaction.type === 'purchase' &&
                      transaction.PaidFunds &&
                      transaction.PaidFunds.length > 0 ? (
                      transaction.PaidFunds.map((fund, index) => (
                        <p key={index}>
                          {formatAssetAmount(fund.amount, fund.unit, transactionNetwork)}
                        </p>
                      ))
                    ) : (
                      <p>—</p>
                    )}
                  </div>
                </div>

                <div className="col-span-2">
                  <h5 className="text-sm font-medium mb-1">Transaction Hash</h5>
                  {(() => {
                    // Fall back to the latest historical hash so an error-state row
                    // (cleared CurrentTransaction) still shows its last on-chain tx.
                    const displayTxHash = getLatestTxHash(transaction);
                    const isHistorical = !transaction.CurrentTransaction?.txHash;
                    return displayTxHash ? (
                      <div className="flex items-center gap-2 bg-muted/30 rounded-md p-2">
                        <a
                          href={getExplorerUrl(displayTxHash, transactionNetwork, 'transaction')}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-sm font-mono break-all hover:underline text-primary"
                        >
                          {displayTxHash}
                        </a>
                        <CopyButton value={displayTxHash} />
                        {isHistorical && (
                          <span className="text-xs text-muted-foreground whitespace-nowrap">
                            (previous)
                          </span>
                        )}
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">No transaction hash available</p>
                    );
                  })()}
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <h4 className="font-semibold">Time Information</h4>
              <div className="grid grid-cols-2 gap-4 rounded-md border p-4 bg-muted/10">
                <div>
                  <h5 className="text-sm font-medium mb-1">Created</h5>
                  <p className="text-sm">{formatDateTime(transaction.createdAt)}</p>
                </div>
                <div>
                  <h5 className="text-sm font-medium mb-1">Last Updated</h5>
                  <p className="text-sm">{formatDateTime(transaction.updatedAt)}</p>
                </div>
                <div>
                  <h5 className="text-sm font-medium mb-1">Submit Result By</h5>
                  <p className="text-sm">{formatDateTime(transaction.submitResultTime)}</p>
                </div>
                <div>
                  <h5 className="text-sm font-medium mb-1">Unlock Time</h5>
                  <p className="text-sm">{formatDateTime(transaction.unlockTime)}</p>
                </div>
                <div>
                  <h5 className="text-sm font-medium mb-1">External Dispute Unlock Time</h5>
                  <p className="text-sm">{formatDateTime(transaction.externalDisputeUnlockTime)}</p>
                </div>
                <div>
                  <h5 className="text-sm font-medium mb-1">Last Checked</h5>
                  <p className="text-sm">{formatDateTime(transaction.lastCheckedAt)}</p>
                </div>
              </div>
            </div>

            {walletInfo && (
              <div className="space-y-2">
                <h4 className="font-semibold">Wallet Information</h4>
                <div className="grid grid-cols-1 gap-4 rounded-md border p-4 bg-muted/10">
                  {walletInfo.smartContractAddress && (
                    <div>
                      <h5 className="text-sm font-medium mb-1">Smart Contract Address</h5>
                      <WalletLink
                        address={walletInfo.smartContractAddress}
                        network={transactionNetwork}
                      />
                    </div>
                  )}
                  {(walletInfo.sellerVkey || walletInfo.sellerAddress) && (
                    <div>
                      <h5 className="text-sm font-medium mb-1">Seller Wallet</h5>
                      <WalletLink
                        address={walletInfo.sellerAddress}
                        vkey={walletInfo.sellerVkey}
                        network={transactionNetwork}
                        onInternalClick={
                          walletInfo.sellerVkey && isInternalWallet(walletInfo.sellerVkey)
                            ? () => handleWalletClick(walletInfo.sellerVkey!)
                            : undefined
                        }
                      />
                    </div>
                  )}
                  {(walletInfo.buyerVkey || walletInfo.buyerAddress) && (
                    <div>
                      <h5 className="text-sm font-medium mb-1">Buyer Wallet</h5>
                      <WalletLink
                        address={walletInfo.buyerAddress}
                        vkey={walletInfo.buyerVkey}
                        network={transactionNetwork}
                        onInternalClick={
                          walletInfo.buyerVkey && isInternalWallet(walletInfo.buyerVkey)
                            ? () => handleWalletClick(walletInfo.buyerVkey!)
                            : undefined
                        }
                      />
                    </div>
                  )}
                </div>
              </div>
            )}

            <TransactionErrorSection
              transaction={transaction}
              isLoading={isLoading}
              errorRecoveryMode={errorRecoveryMode}
              onRecover={recoverTransactionError}
            />

            <TransactionHistorySection transaction={transaction} network={transactionNetwork} />

            <div className="flex gap-2 justify-end">
              <Button
                variant="outline"
                onClick={() => setShowRepairDialog(true)}
                disabled={isLoading}
                title="Point this request at a specific transaction when the database has fallen behind the chain"
              >
                Repair Request
              </Button>
              {canRequestRefund(transaction) && transaction.type === 'purchase' && (
                <Button
                  variant="secondary"
                  onClick={() => handleRefundRequest(transaction)}
                  disabled={isLoading}
                >
                  {isLoading ? 'Requesting refund...' : 'Request Refund'}
                </Button>
              )}
              {canAllowRefund(transaction) && transaction.type === 'payment' && (
                <Button
                  variant="default"
                  onClick={() => {
                    setConfirmAction('refund');
                    setShowConfirmDialog(true);
                  }}
                  className="bg-orange-600 hover:bg-orange-700"
                >
                  Authorize Refund
                </Button>
              )}
              {canCancelRefund(transaction) && transaction.type === 'purchase' && (
                <Button
                  variant="destructive"
                  onClick={() => {
                    setConfirmAction('cancel');
                    setShowConfirmDialog(true);
                  }}
                >
                  Cancel Refund Request
                </Button>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={showConfirmDialog}
        onClose={() => {
          setShowConfirmDialog(false);
          setConfirmAction(null);
        }}
        title={confirmAction === 'refund' ? 'Authorize Refund' : 'Cancel Refund Request'}
        description={
          confirmAction === 'refund'
            ? 'Are you sure you want to authorize this refund?'
            : 'Are you sure you want to cancel this refund request?'
        }
        onConfirm={async () => {
          if (!transaction) return;

          setIsLoading(true);
          try {
            if (confirmAction === 'refund') {
              await handleAllowRefund(transaction);
            } else if (confirmAction === 'cancel') {
              await handleCancelRefund(transaction);
            }
          } finally {
            setIsLoading(false);
            setShowConfirmDialog(false);
            setConfirmAction(null);
          }
        }}
        isLoading={isLoading}
      />
      <RequestRepairDialog
        open={showRepairDialog}
        onClose={() => setShowRepairDialog(false)}
        kind={transaction.type === 'purchase' ? 'Purchase' : 'Payment'}
        network={transactionNetwork}
        blockchainIdentifier={transaction.blockchainIdentifier}
        requestUpdatedAt={transaction.updatedAt}
        onRepaired={() => {
          onRefresh();
          onClose();
        }}
      />
      <WalletDetailsDialog
        isOpen={!!selectedWalletForDetails}
        onClose={() => setSelectedWalletForDetails(null)}
        wallet={selectedWalletForDetails}
        isChild
      />
    </>
  );
}
