import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn, getExplorerUrl } from '@/lib/utils';
import { formatDateTime } from '@/lib/format-date';
import { CopyButton } from '@/components/ui/copy-button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  formatOnChainState,
  formatRequestedAction,
  formatTxStatus,
  getTxStatusColor,
  type Transaction,
} from './transaction-format.helpers';

interface TransactionHistorySectionProps {
  transaction: Transaction;
  network: string;
}

const byCreatedAtDesc = <T extends { createdAt: Date }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

/**
 * Common shape across payment and purchase action-history rows. Payment rows
 * additionally carry `submittedTxHash`; purchase rows don't, so it's optional.
 */
type HistoryAction = {
  id: string;
  createdAt: Date;
  requestedAction: string;
  errorType: string | null;
  errorNote: string | null;
  submittedTxHash?: string | null;
};

const TxHashLink = ({ txHash, network }: { txHash: string; network: string }) => (
  <div className="flex items-center gap-1.5 min-w-0">
    <a
      href={getExplorerUrl(txHash, network, 'transaction')}
      target="_blank"
      rel="noopener noreferrer"
      className="text-xs font-mono break-all hover:underline text-primary"
    >
      {txHash}
    </a>
    <CopyButton value={txHash} />
  </div>
);

const StateTransition = ({ previous, next }: { previous: string | null; next: string | null }) => {
  if (!previous && !next) return null;
  return (
    <span className="text-xs text-muted-foreground">
      {previous ? formatOnChainState(previous) : 'Initial'} →{' '}
      {next ? formatOnChainState(next) : '—'}
    </span>
  );
};

export function TransactionHistorySection({
  transaction,
  network,
}: TransactionHistorySectionProps) {
  const [isOpen, setIsOpen] = useState(false);

  const transactions = byCreatedAtDesc(transaction.TransactionHistory ?? []);
  const actions = byCreatedAtDesc((transaction.ActionHistory ?? []) as readonly HistoryAction[]);

  if (transactions.length === 0 && actions.length === 0) return null;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className="space-y-2">
      <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md border p-3 bg-muted/10 hover:bg-muted/30 transition-colors">
        <div className="flex items-center gap-2">
          <h4 className="font-semibold">History</h4>
          <span className="text-xs text-muted-foreground">
            {transactions.length} transaction{transactions.length === 1 ? '' : 's'}
            {actions.length > 0 && `, ${actions.length} action${actions.length === 1 ? '' : 's'}`}
          </span>
        </div>
        <ChevronDown
          className={cn(
            'h-4 w-4 text-muted-foreground transition-transform',
            isOpen && 'rotate-180',
          )}
        />
      </CollapsibleTrigger>

      <CollapsibleContent className="space-y-4">
        {transactions.length > 0 && (
          <div className="space-y-2">
            <h5 className="text-sm font-medium text-muted-foreground">Transaction history</h5>
            <ol className="space-y-2">
              {transactions.map((tx) => (
                <li key={tx.id} className="rounded-md border p-3 bg-muted/10 space-y-1.5">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className={cn('text-sm font-medium', getTxStatusColor(tx.status))}>
                      {formatTxStatus(tx.status)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatDateTime(tx.createdAt)}
                    </span>
                  </div>
                  <StateTransition previous={tx.previousOnChainState} next={tx.newOnChainState} />
                  {tx.txHash ? (
                    <TxHashLink txHash={tx.txHash} network={network} />
                  ) : (
                    <p className="text-xs text-muted-foreground">No transaction hash</p>
                  )}
                  {typeof tx.confirmations === 'number' && (
                    <p className="text-xs text-muted-foreground">
                      {tx.confirmations} confirmation{tx.confirmations === 1 ? '' : 's'}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}

        {actions.length > 0 && (
          <div className="space-y-2">
            <h5 className="text-sm font-medium text-muted-foreground">Action history</h5>
            <ol className="space-y-2">
              {actions.map((action) => (
                <li key={action.id} className="rounded-md border p-3 bg-muted/10 space-y-1.5">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-sm font-medium">
                      {formatRequestedAction(action.requestedAction)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatDateTime(action.createdAt)}
                    </span>
                  </div>
                  {'submittedTxHash' in action && action.submittedTxHash && (
                    <TxHashLink txHash={action.submittedTxHash} network={network} />
                  )}
                  {action.errorType && (
                    <p className="text-xs text-destructive break-all">
                      <span className="font-medium">Error:</span> {action.errorType}
                      {action.errorNote ? ` — ${action.errorNote}` : ''}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
