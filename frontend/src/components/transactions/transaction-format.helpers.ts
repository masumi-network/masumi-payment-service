import type { Payment, Purchase } from '@/lib/api/generated';

/**
 * A transaction row is either a Payment or a Purchase, tagged with `type` so
 * the UI can branch on the party roles (buyer/seller) that differ between them.
 */
export type Transaction =
  | (Payment & { type: 'payment' })
  | (Purchase & {
      type: 'purchase';
    });

/** On-chain transaction lifecycle status shared by CurrentTransaction and TransactionHistory rows. */
export type TxStatus = NonNullable<Transaction['CurrentTransaction']>['status'];

export const getStatusColor = (status: string | null, hasError?: boolean) => {
  if (hasError) return 'text-destructive';
  switch (status?.toLowerCase()) {
    case 'fundslocked':
      return 'text-yellow-500';
    case 'withdrawn':
    case 'resultsubmitted':
      return 'text-green-500';
    case 'refundrequested':
    case 'withdrawauthorized':
    case 'refundauthorized':
      return 'text-orange-500';
    case 'refundwithdrawn':
      return 'text-blue-500';
    case 'disputed':
    case 'disputedwithdrawn':
      return 'text-destructive';
    default:
      return 'text-muted-foreground';
  }
};

export const formatStatus = (status: string | null) => {
  if (!status) return '—';
  return status.replace(/([A-Z])/g, ' $1').trim();
};

/** Human-readable label for an on-chain state (e.g. `FundsLocked` -> `Funds Locked`). */
export const formatOnChainState = (state: string | null | undefined): string => {
  switch (state?.toLowerCase()) {
    case 'fundslocked':
      return 'Funds Locked';
    case 'resultsubmitted':
      return 'Result Submitted';
    case 'refundrequested':
      return 'Refund Requested (waiting for approval)';
    case 'withdrawauthorized':
      return 'Withdraw Authorized';
    case 'refundauthorized':
      return 'Refund Authorized';
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
    default:
      return state ? state.charAt(0).toUpperCase() + state.slice(1) : '—';
  }
};

/** Human-readable label for a `NextAction.requestedAction` value (covers both payment and purchase actions). */
export const formatRequestedAction = (action: string | null | undefined): string => {
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
    case 'UnSetRefundRequestedRequested':
      return 'Cancel refund request initiated';
    case 'UnSetRefundRequestedInitiated':
      return 'Cancel refund request in progress';
    case 'WithdrawRequested':
      return 'Withdraw requested';
    case 'WithdrawInitiated':
      return 'Withdraw initiated';
    case 'WithdrawRefundRequested':
      return 'Refund withdraw requested';
    case 'WithdrawRefundInitiated':
      return 'Refund withdraw initiated';
    case 'AuthorizeWithdrawalRequested':
      return 'Withdrawal authorization requested';
    case 'AuthorizeWithdrawalInitiated':
      return 'Withdrawal authorization initiated';
    case 'SubmitResultRequested':
      return 'Submit result requested';
    case 'SubmitResultInitiated':
      return 'Submit result initiated';
    case 'AuthorizeRefundRequested':
      return 'Authorize refund requested';
    case 'AuthorizeRefundInitiated':
      return 'Authorize refund initiated';
    default:
      return action ?? '—';
  }
};

/** Human-readable label for a transaction status (e.g. `FailedViaTimeout` -> `Failed (timeout)`). */
export const formatTxStatus = (status: TxStatus | null | undefined): string => {
  switch (status) {
    case 'Pending':
      return 'Pending';
    case 'Confirmed':
      return 'Confirmed';
    case 'FailedViaTimeout':
      return 'Failed (timeout)';
    case 'FailedViaManualReset':
      return 'Failed (manual reset)';
    case 'RolledBack':
      return 'Rolled back';
    default:
      return status ?? '—';
  }
};

export const getTxStatusColor = (status: TxStatus | null | undefined): string => {
  switch (status) {
    case 'Confirmed':
      return 'text-green-500';
    case 'Pending':
      return 'text-yellow-500';
    case 'FailedViaTimeout':
    case 'FailedViaManualReset':
    case 'RolledBack':
      return 'text-destructive';
    default:
      return 'text-muted-foreground';
  }
};

/**
 * Transaction hash to display for a row.
 *
 * Prefers the active `CurrentTransaction`, but falls back to the most recent
 * transaction in `TransactionHistory` that carries a hash. Without the
 * fallback, a row in an error state (where `CurrentTransaction` has been
 * cleared) renders "—" even though earlier confirmed transactions exist —
 * hiding the on-chain history the user needs to investigate.
 */
export const getLatestTxHash = (transaction: Transaction): string | null => {
  if (transaction.CurrentTransaction?.txHash) {
    return transaction.CurrentTransaction.txHash;
  }
  const withHash = (transaction.TransactionHistory ?? []).filter((tx) => tx.txHash);
  if (withHash.length === 0) return null;
  const latest = withHash.reduce((a, b) =>
    new Date(a.createdAt).getTime() >= new Date(b.createdAt).getTime() ? a : b,
  );
  return latest.txHash;
};
