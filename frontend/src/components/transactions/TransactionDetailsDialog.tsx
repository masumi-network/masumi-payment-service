/* eslint-disable @typescript-eslint/no-explicit-any */
import React from 'react';
import { Button } from '@/components/ui/button';
import { cn, shortenAddress, getExplorerUrl } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CopyButton } from '@/components/ui/copy-button';
import { toast } from 'react-toastify';
import { parseError } from '@/lib/utils';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  GetPaymentResponses,
  GetPurchaseResponses,
  postPurchaseRequestRefund,
  postPurchaseCancelRefundRequest,
  postPaymentAuthorizeRefund,
} from '@/lib/api/generated';

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

interface TransactionDetailsDialogProps {
  transaction: Transaction | null;
  onClose: () => void;
  onRefresh: () => void;
  apiClient: any;
  state: any;
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
  apiClient,
  state,
}: TransactionDetailsDialogProps) {
  const [showConfirmDialog, setShowConfirmDialog] = React.useState(false);
  const [confirmAction, setConfirmAction] = React.useState<
    'refund' | 'cancel' | null
  >(null);
  const [isLoading, setIsLoading] = React.useState(false);
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

  const handleRefundRequest = async (transaction: Transaction) => {
    try {
      const body = {
        blockchainIdentifier: transaction.blockchainIdentifier,
        network: state.network,
      };
      const response = await postPurchaseRequestRefund({
        client: apiClient,
        body,
      });

      if (response.error) {
        const error = response.error as { message: string };
        toast.error(error.message || 'Refund request failed');
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
      toast.error(parseError(error));
    }
  };

  const handleAllowRefund = async (transaction: Transaction) => {
    try {
      const body = {
        blockchainIdentifier: transaction.blockchainIdentifier,
        network: state.network,
      };
      const response = await postPaymentAuthorizeRefund({
        client: apiClient,
        body,
      });

      if (response.error) {
        const error = response.error as { message: string };
        toast.error(error.message || 'Refund authorization failed');
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
      toast.error(parseError(error));
    }
  };

  const handleCancelRefund = async (transaction: Transaction) => {
    try {
      const body = {
        blockchainIdentifier: transaction.blockchainIdentifier,
        network: state.network,
      };
      const response = await postPurchaseCancelRefundRequest({
        client: apiClient,
        body,
      });

      if (response.error) {
        const error = response.error as { message: string };
        toast.error(error.message || 'Refund cancel failed');
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
      toast.error(parseError(error));
    }
  };

  if (!transaction) return null;

  return (
    <Dialog open={!!transaction && !showConfirmDialog} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[600px]">
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

            <div className="col-span-2 my-4">
              <h4 className="font-semibold mb-1">Network</h4>
              <p className="text-sm capitalize">
                {transaction.PaymentSource.network}
              </p>
            </div>

            <div className="col-span-2 w-full mb-4">
              <h4 className="font-semibold mb-1">Blockchain Identifier</h4>
              <div className="text-sm font-mono break-all flex gap-2 items-center">
                <span>{shortenAddress(transaction.blockchainIdentifier)}</span>
                <CopyButton value={transaction.blockchainIdentifier} />
              </div>
            </div>

            <div>
              <h4 className="font-semibold mb-1">Type</h4>
              <p className="text-sm capitalize">{transaction.type}</p>
            </div>
            <div>
              <h4 className="font-semibold mb-1">Created</h4>
              <p className="text-sm">
                {new Date(transaction.createdAt).toLocaleString()}
              </p>
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
                This payment is in dispute. As the seller, you can authorize a
                refund to resolve the dispute.
              </p>
            </div>
          )}

          <div className="space-y-2">
            <h4 className="font-semibold">Onchain state</h4>
            <div className="rounded-md border p-4 bg-muted/10">
              <p className="text-sm font-medium">
                {(() => {
                  const state = transaction.onChainState?.toLowerCase();
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
              {transaction.NextAction?.requestedAction && (
                <p className="text-xs text-muted-foreground mt-1">
                  Next action:{' '}
                  {(() => {
                    const action = transaction.NextAction.requestedAction;
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
                      transaction.onChainState,
                      !!transaction.NextAction?.errorType,
                    ),
                  )}
                >
                  {formatStatus(transaction.onChainState)}
                </p>
              </div>

              <div>
                <h5 className="text-sm font-medium mb-1">Amount</h5>
                <p className="text-sm">
                  {transaction.type === 'payment' &&
                  transaction.RequestedFunds?.[0]
                    ? `${(parseInt(transaction.RequestedFunds[0].amount) / 1000000).toFixed(2)} ₳`
                    : transaction.type === 'purchase' &&
                        transaction.PaidFunds?.[0]
                      ? `${(parseInt(transaction.PaidFunds[0].amount) / 1000000).toFixed(2)} ₳`
                      : '—'}
                </p>
              </div>

              <div className="col-span-2">
                <h5 className="text-sm font-medium mb-1">Transaction Hash</h5>
                {transaction.CurrentTransaction?.txHash ? (
                  <div className="flex items-center gap-2 bg-muted/30 rounded-md p-2">
                    <a
                      href={getExplorerUrl(
                        transaction.CurrentTransaction.txHash,
                        state.network,
                        'transaction',
                      )}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-mono break-all hover:underline text-primary"
                    >
                      {transaction.CurrentTransaction.txHash}
                    </a>
                    <CopyButton
                      value={transaction.CurrentTransaction?.txHash}
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
                  {formatTimestamp(transaction.createdAt)}
                </p>
              </div>
              <div>
                <h5 className="text-sm font-medium mb-1">Last Updated</h5>
                <p className="text-sm">
                  {formatTimestamp(transaction.updatedAt)}
                </p>
              </div>
              <div>
                <h5 className="text-sm font-medium mb-1">Submit Result By</h5>
                <p className="text-sm">
                  {formatTimestamp(transaction.submitResultTime)}
                </p>
              </div>
              <div>
                <h5 className="text-sm font-medium mb-1">Unlock Time</h5>
                <p className="text-sm">
                  {formatTimestamp(transaction.unlockTime)}
                </p>
              </div>
              <div>
                <h5 className="text-sm font-medium mb-1">
                  External Dispute Unlock Time
                </h5>
                <p className="text-sm">
                  {formatTimestamp(transaction.externalDisputeUnlockTime)}
                </p>
              </div>
              <div>
                <h5 className="text-sm font-medium mb-1">Last Checked</h5>
                <p className="text-sm">
                  {formatTimestamp(transaction.lastCheckedAt)}
                </p>
              </div>
            </div>
          </div>

          {transaction.type === 'payment' &&
            transaction.SmartContractWallet && (
              <div className="space-y-2">
                <h4 className="font-semibold">Wallet Information</h4>
                <div className="grid grid-cols-1 gap-4 rounded-md border p-4">
                  <div>
                    <h5 className="text-sm font-medium mb-1">
                      Collection Wallet
                    </h5>
                    <div className="flex items-center gap-2">
                      <a
                        href={getExplorerUrl(
                          transaction.SmartContractWallet.walletAddress,
                          state.network,
                          'address',
                        )}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-mono break-all hover:underline text-primary"
                      >
                        {transaction.SmartContractWallet.walletAddress}
                      </a>
                      <CopyButton
                        value={transaction.SmartContractWallet?.walletAddress}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}

          {transaction.NextAction?.errorType && (
            <div className="space-y-2 break-all">
              <h4 className="font-semibold">Error Details</h4>
              <div className="space-y-2 rounded-md bg-destructive/20 p-4">
                <div className="space-y-1">
                  <p className="text-sm">
                    <span className="font-medium">Error Type:</span>{' '}
                    {transaction.NextAction.errorType}
                  </p>
                  {transaction.NextAction.errorNote && (
                    <p className="text-sm">
                      <span className="font-medium">Error Note:</span>{' '}
                      {transaction.NextAction.errorNote}
                    </p>
                  )}
                  <div className="flex gap-2 mt-4">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={async () => {
                        if (await clearTransactionError(transaction)) {
                          onClose();
                          onRefresh();
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
                          (await updateTransactionState(transaction, newState))
                        ) {
                          onClose();
                          onRefresh();
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
            {canRequestRefund(transaction) &&
              transaction.type === 'purchase' && (
                <Button
                  variant="secondary"
                  onClick={() => handleRefundRequest(transaction)}
                >
                  Request Refund
                </Button>
              )}
            {canAllowRefund(transaction) && (
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
            {canCancelRefund(transaction) &&
              transaction.type === 'purchase' && (
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

      <ConfirmDialog
        open={showConfirmDialog}
        onClose={() => {
          setShowConfirmDialog(false);
          setConfirmAction(null);
        }}
        title={
          confirmAction === 'refund'
            ? 'Authorize Refund'
            : 'Cancel Refund Request'
        }
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
    </Dialog>
  );
}
