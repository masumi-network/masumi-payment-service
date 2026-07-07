import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { RefreshCw, XCircle, AlertTriangle } from 'lucide-react';
import { formatDateTime } from '@/lib/format-date';
import { shortenAddress, getExplorerUrl } from '@/lib/utils';
import type { SwapTransactionPayload } from '@/components/wallets/swap-api';

// The dialog's local swap-tx shape is exactly the API payload shape.
export type SwapTx = SwapTransactionPayload;

export function SwapTransactionsSection({
  swapTransactions,
  swapTxLoading,
  hasMoreSwapTx,
  swapTxCursor,
  pollingTxId,
  actionLoadingId,
  network,
  onRefresh,
  onLoadMore,
  onCancelSwap,
  onAcknowledgeTimeout,
  onStartPollingConfirm,
}: {
  swapTransactions: SwapTx[];
  swapTxLoading: boolean;
  hasMoreSwapTx: boolean;
  swapTxCursor: string | undefined;
  pollingTxId: string | null;
  actionLoadingId: string | null;
  network: 'Preprod' | 'Mainnet';
  onRefresh: () => void;
  onLoadMore: (cursor?: string) => void;
  onCancelSwap: (tx: SwapTx) => void;
  onAcknowledgeTimeout: (tx: SwapTx) => void;
  onStartPollingConfirm: (txId: string, txHash: string) => void;
}) {
  return (
    <div className="bg-muted rounded-lg p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">Swap Transactions</div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh swap transactions"
          className="h-7 w-7"
          onClick={onRefresh}
          disabled={swapTxLoading}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${swapTxLoading ? 'animate-spin' : ''}`} />
        </Button>
      </div>
      <div className="space-y-2">
        {swapTransactions.map((tx) => {
          const fromLabel = tx.fromPolicyId ? shortenAddress(tx.fromPolicyId) : 'ADA';
          const toLabel = tx.toPolicyId ? shortenAddress(tx.toPolicyId) : 'ADA';
          const displayStatus = tx.swapStatus || tx.status;

          const statusDotMap: Record<string, string> = {
            OrderPending: 'bg-yellow-500',
            OrderConfirmed: 'bg-blue-500',
            CancelPending: 'bg-orange-500',
            CancelConfirmed: 'bg-purple-500',
            Completed: 'bg-green-500',
            Confirmed: 'bg-green-500',
            Pending: 'bg-yellow-500',
            OrderSubmitTimeout: 'bg-red-500',
            CancelSubmitTimeout: 'bg-red-500',
          };
          const statusColorMap: Record<string, string> = {
            OrderPending: 'text-yellow-500',
            OrderConfirmed: 'text-blue-500',
            CancelPending: 'text-orange-500',
            CancelConfirmed: 'text-purple-500',
            Completed: 'text-green-500',
            Confirmed: 'text-green-500',
            Pending: 'text-yellow-500',
            OrderSubmitTimeout: 'text-destructive',
            CancelSubmitTimeout: 'text-destructive',
          };
          const statusColor = statusColorMap[displayStatus] || 'text-destructive';
          const dotColor = statusDotMap[displayStatus] || 'bg-red-500';
          const statusLabelMap: Record<string, string> = {
            OrderPending: 'Order Pending',
            OrderConfirmed: 'Awaiting Execution',
            CancelPending: 'Cancel Pending',
            CancelConfirmed: 'Cancelled',
            Completed: 'Completed',
            OrderSubmitTimeout: 'Order Timeout',
            CancelSubmitTimeout: 'Cancel Timeout',
          };
          const statusLabel = statusLabelMap[displayStatus] || displayStatus;

          const isActionable =
            displayStatus === 'OrderConfirmed' ||
            displayStatus === 'OrderPending' ||
            displayStatus === 'CancelPending' ||
            displayStatus === 'OrderSubmitTimeout' ||
            displayStatus === 'CancelSubmitTimeout';
          const isPending = displayStatus === 'OrderPending' || displayStatus === 'CancelPending';
          const isTimeout =
            displayStatus === 'OrderSubmitTimeout' || displayStatus === 'CancelSubmitTimeout';

          return (
            <div
              key={tx.id}
              className={`rounded-lg border p-3 space-y-2 transition-colors ${
                isTimeout
                  ? 'border-destructive/30 bg-red-500/5'
                  : displayStatus === 'OrderConfirmed'
                    ? 'border-blue-500/20 bg-blue-500/5'
                    : 'dark:border-muted-foreground/20 border-border'
              }`}
            >
              {/* Header row */}
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">
                  {tx.fromAmount} {fromLabel} → {toLabel}
                </span>
                <div className="flex items-center gap-1.5">
                  {pollingTxId === tx.id && <Spinner size={12} />}
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${statusColor} bg-background/60`}
                  >
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${dotColor} ${isPending ? 'animate-pulse' : ''}`}
                    />
                    {statusLabel}
                  </span>
                </div>
              </div>

              {/* Tx links */}
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{formatDateTime(tx.createdAt)}</span>
                <div className="flex items-center gap-2">
                  {tx.cancelTxHash && (
                    <a
                      href={getExplorerUrl(tx.cancelTxHash, network, 'transaction')}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 hover:underline text-orange-500"
                      title="Cancel tx"
                    >
                      {shortenAddress(tx.cancelTxHash, 4)}
                    </a>
                  )}
                  {tx.txHash && (
                    <a
                      href={getExplorerUrl(tx.txHash, network, 'transaction')}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 hover:underline text-primary"
                    >
                      {shortenAddress(tx.txHash, 6)}
                    </a>
                  )}
                </div>
              </div>

              {/* Actions */}
              {isActionable && (
                <div className="pt-1">
                  {displayStatus === 'OrderConfirmed' && (
                    <Button
                      variant="destructive"
                      size="sm"
                      className="w-full h-7 text-xs rounded-md"
                      onClick={() => onCancelSwap(tx)}
                      disabled={actionLoadingId === tx.id || pollingTxId === tx.id}
                    >
                      {actionLoadingId === tx.id ? (
                        <Spinner size={12} />
                      ) : (
                        <>
                          <XCircle className="h-3 w-3 mr-1" />
                          Cancel Order
                        </>
                      )}
                    </Button>
                  )}

                  {isPending && pollingTxId !== tx.id && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full h-7 text-xs rounded-md text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        const hash =
                          displayStatus === 'CancelPending' ? tx.cancelTxHash : tx.txHash;
                        if (hash) onStartPollingConfirm(tx.id, hash);
                      }}
                      disabled={!tx.txHash && !tx.cancelTxHash}
                    >
                      <RefreshCw className="h-3 w-3 mr-1" />
                      Check Status
                    </Button>
                  )}

                  {isTimeout && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full h-7 text-xs rounded-md border-destructive/40 text-red-400 hover:bg-red-500/10"
                      onClick={() => onAcknowledgeTimeout(tx)}
                      disabled={actionLoadingId === tx.id}
                    >
                      {actionLoadingId === tx.id ? (
                        <Spinner size={12} />
                      ) : (
                        <>
                          <AlertTriangle className="h-3 w-3 mr-1" />
                          Acknowledge &amp; Recover
                        </>
                      )}
                    </Button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {hasMoreSwapTx && (
        <Button
          variant="ghost"
          size="sm"
          className="w-full"
          onClick={() => onLoadMore(swapTxCursor)}
          disabled={swapTxLoading}
        >
          {swapTxLoading ? <Spinner size={16} /> : 'Load more'}
        </Button>
      )}
    </div>
  );
}
