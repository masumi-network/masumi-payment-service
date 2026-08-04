import { Button } from '@/components/ui/button';
import type { Transaction } from './transaction-format.helpers';

interface TransactionErrorSectionProps {
  transaction: Transaction;
  /** Any action on the transaction is in flight. */
  isLoading: boolean;
  /** Which recovery is currently running, so the button can say so. */
  errorRecoveryMode: 'clear' | 'retry' | null;
  onRecover: (retryPreviousAction: boolean) => void;
}

/**
 * The recorded NextAction error and the two ways out of it.
 *
 * Renders nothing when the transaction has no error, so callers can include it
 * unconditionally.
 */
export function TransactionErrorSection({
  transaction,
  isLoading,
  errorRecoveryMode,
  onRecover,
}: TransactionErrorSectionProps) {
  if (!transaction.NextAction?.errorType) return null;

  return (
    <div className="space-y-2 break-all">
      <h4 className="font-semibold">Error Details</h4>
      <div className="space-y-2 rounded-md bg-destructive/20 p-4">
        <div className="space-y-1">
          <p className="text-sm">
            <span className="font-medium">Error Type:</span> {transaction.NextAction.errorType}
          </p>
          {transaction.NextAction.errorNote && (
            <p className="text-sm">
              <span className="font-medium">Error Note:</span> {transaction.NextAction.errorNote}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Retry queues the failed blockchain action again with its original data. Clear only
            removes the error and waits for the next external action.
          </p>
          <div className="flex flex-wrap gap-2 mt-4">
            <Button size="sm" disabled={isLoading} onClick={() => onRecover(true)}>
              {errorRecoveryMode === 'retry' ? 'Queueing retry...' : 'Retry Failed Action'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={isLoading}
              onClick={() => onRecover(false)}
            >
              {errorRecoveryMode === 'clear' ? 'Clearing error state...' : 'Clear Error State'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
