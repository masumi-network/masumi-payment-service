import { ExternalLink, Eye, MoreHorizontal, RotateCcw, Eraser } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getExplorerUrl } from '@/lib/utils';
import { getLatestTxHash, type Transaction } from './transaction-format.helpers';

type TransactionRowActionsMenuProps = {
  transaction: Transaction;
  canRecover: boolean;
  isRecovering: boolean;
  onViewDetails: () => void;
  onClearError: () => void;
  onRetryFailedAction: () => void;
};

export function TransactionRowActionsMenu({
  transaction,
  canRecover,
  isRecovering,
  onViewDetails,
  onClearError,
  onRetryFailedAction,
}: TransactionRowActionsMenuProps) {
  const txHash = getLatestTxHash(transaction);
  const txNetwork = transaction.PaymentSource?.network;
  const hasError = !!transaction.NextAction?.errorType;
  const explorerUrl = txHash && txNetwork ? getExplorerUrl(txHash, txNetwork, 'transaction') : null;

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Transaction actions"
          className="h-8 w-8"
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
        <DropdownMenuItem className="cursor-pointer gap-2" onSelect={() => onViewDetails()}>
          <Eye className="h-4 w-4" />
          View details
        </DropdownMenuItem>
        {explorerUrl && (
          <DropdownMenuItem className="cursor-pointer gap-2" asChild>
            <a href={explorerUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="h-4 w-4" />
              Open in explorer
            </a>
          </DropdownMenuItem>
        )}
        {hasError && canRecover && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="cursor-pointer gap-2"
              disabled={isRecovering}
              onSelect={() => onClearError()}
            >
              <Eraser className="h-4 w-4" />
              Clear error state
            </DropdownMenuItem>
            <DropdownMenuItem
              className="cursor-pointer gap-2"
              disabled={isRecovering}
              onSelect={() => onRetryFailedAction()}
            >
              <RotateCcw className="h-4 w-4" />
              Retry failed action
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
