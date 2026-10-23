import { cn, formatAssetAmount } from '@/lib/utils';
import { formatDateTime } from '@/lib/format-date';
import {
  tableActionsCellCompactClass,
  tableActionsCellCompactDestructiveClass,
  tableActionsCellCompactSelectedClass,
  tableActionsInnerClass,
} from '@/components/ui/table-actions-column';
import { CopyButton } from '@/components/ui/copy-button';
import { Badge } from '@/components/ui/badge';
import { TableSelectRowCheckbox } from '@/components/ui/table-select-checkbox';
import { PaymentSourceTypeBadge } from '@/components/payment-sources/PaymentSourceTypeBadge';
import { TransactionAgentIdentifierCell } from '@/components/transactions/TransactionAgentIdentifierCell';
import { TransactionRowActionsMenu } from '@/components/transactions/TransactionRowActionsMenu';
import {
  formatStatus,
  getLatestTxHash,
  getNotPaidInTimeLabel,
  getStatusColor,
  hasUnacknowledgedError,
  type Transaction,
} from '@/components/transactions/transaction-format.helpers';

const isHydraTransaction = (transaction: Transaction) =>
  transaction.CurrentTransaction?.layer === 'L2';

// The layer (L1 vs Hydra L2) is only known once the request has been picked up
// and locked (i.e. a CurrentTransaction exists). Before that, show neither.
const getTransactionLayerLabel = (transaction: Transaction): 'Hydra L2' | 'L1' | null => {
  const layer = transaction.CurrentTransaction?.layer;
  if (layer === 'L2') return 'Hydra L2';
  if (layer === 'L1') return 'L1';
  return null;
};

const getHydraHeadId = (transaction: Transaction) =>
  transaction.CurrentTransaction?.hydraHeadId ?? null;

type TransactionTableRowProps = {
  transaction: Transaction;
  index: number;
  network: string;
  isSelected: boolean;
  canRecover: boolean;
  isRecovering: boolean;
  onToggleSelected: () => void;
  onOpen: () => void;
  onClearError: () => void;
  onRetryFailedAction: () => void;
  onAcknowledge?: () => void;
};

export function TransactionTableRow({
  transaction,
  index,
  network,
  isSelected,
  canRecover,
  isRecovering,
  onToggleSelected,
  onOpen,
  onClearError,
  onRetryFailedAction,
  onAcknowledge,
}: TransactionTableRowProps) {
  const hasTxError = !!transaction.NextAction?.errorType;
  const isErrorHighlighted = hasUnacknowledgedError(transaction);
  const notPaidInTimeLabel = getNotPaidInTimeLabel(transaction);
  const displayTxHash = getLatestTxHash(transaction);

  return (
    <tr
      className={cn(
        'group border-b last:border-b-0 animate-fade-in opacity-0',
        'cursor-pointer',
        isErrorHighlighted ? 'transaction-row-error' : 'hover:bg-row-hover',
        isSelected &&
          (isErrorHighlighted
            ? 'transaction-row-selected'
            : 'transaction-row-selected bg-row-hover'),
      )}
      style={{ animationDelay: `${Math.min(index, 9) * 40}ms` }}
      onClick={onOpen}
    >
      <td className="w-10 p-4 pl-6" onClick={(e) => e.stopPropagation()}>
        <TableSelectRowCheckbox
          checked={isSelected}
          onToggle={onToggleSelected}
          aria-label="Select transaction"
        />
      </td>
      <td className="p-4">
        <span className="capitalize">{transaction.type}</span>
      </td>
      <td className="p-4">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm text-muted-foreground">
            {displayTxHash ? `${displayTxHash.slice(0, 8)}...${displayTxHash.slice(-8)}` : '—'}
          </span>
          {displayTxHash && <CopyButton value={displayTxHash} />}
        </div>
      </td>
      <td className="p-4">
        <TransactionAgentIdentifierCell
          agentIdentifier={transaction.agentIdentifier}
          agentName={transaction.agentName}
          smartContractAddress={transaction.PaymentSource?.smartContractAddress ?? null}
          network={transaction.PaymentSource?.network}
        />
      </td>
      <td className="p-4">
        {transaction.type === 'payment' && transaction.RequestedFunds?.length
          ? transaction.RequestedFunds.map((fund, index) => (
              <div key={index} className="text-sm">
                {formatAssetAmount(fund.amount, fund.unit, network)}
              </div>
            ))
          : transaction.type === 'purchase' && transaction.PaidFunds?.length
            ? transaction.PaidFunds.map((fund, index) => (
                <div key={index} className="text-sm">
                  {formatAssetAmount(fund.amount, fund.unit, network)}
                </div>
              ))
            : '—'}
      </td>
      <td className="p-4">
        <div className="flex flex-col gap-1">
          <span>{transaction.PaymentSource.network}</span>
          <PaymentSourceTypeBadge
            paymentSourceType={transaction.PaymentSource.paymentSourceType}
            showDefault
          />
          <div className="flex items-center gap-1.5">
            {getTransactionLayerLabel(transaction) ? (
              <Badge
                variant={isHydraTransaction(transaction) ? 'success' : 'outline'}
                className="w-fit"
              >
                {getTransactionLayerLabel(transaction)}
              </Badge>
            ) : (
              <span className="text-xs text-muted-foreground">—</span>
            )}
            {isHydraTransaction(transaction) && getHydraHeadId(transaction) && (
              <span
                className="max-w-[120px] truncate font-mono text-xs text-muted-foreground"
                title={getHydraHeadId(transaction) ?? undefined}
              >
                {getHydraHeadId(transaction)}
              </span>
            )}
          </div>
        </div>
      </td>
      <td className="p-4">
        <span className={getStatusColor(transaction.onChainState, hasTxError)}>
          {transaction.onChainState === 'Disputed' ? (
            <span className="flex items-center gap-1">
              <div className="w-2 h-2 bg-orange-500 rounded-full animate-subtle-pulse"></div>
              {formatStatus(transaction.onChainState)}
            </span>
          ) : notPaidInTimeLabel ? (
            notPaidInTimeLabel
          ) : (
            formatStatus(transaction.onChainState)
          )}
        </span>
      </td>
      <td className="p-4">
        {transaction.onChainState === 'ResultSubmitted'
          ? formatDateTime(transaction.unlockTime)
          : '—'}
      </td>
      <td className="p-4">{formatDateTime(transaction.createdAt)}</td>
      <td
        className={
          isSelected
            ? tableActionsCellCompactSelectedClass
            : isErrorHighlighted
              ? tableActionsCellCompactDestructiveClass
              : tableActionsCellCompactClass
        }
        onClick={(e) => e.stopPropagation()}
      >
        <div className={tableActionsInnerClass}>
          <TransactionRowActionsMenu
            transaction={transaction}
            canRecover={canRecover}
            isRecovering={isRecovering}
            onViewDetails={onOpen}
            onClearError={onClearError}
            onRetryFailedAction={onRetryFailedAction}
            onAcknowledge={onAcknowledge}
          />
        </div>
      </td>
    </tr>
  );
}
