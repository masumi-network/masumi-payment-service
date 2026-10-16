import type { X402PaymentAttempt, X402Wallet } from '@/lib/api/generated';

/** Split CamelCase enums into spaced words, with a safe fallback. */
export function formatEnumLabel(value: string | null | undefined, fallback = '—'): string {
  if (!value) return fallback;
  return value.replace(/([A-Z])/g, ' $1').trim();
}

const X402_PAYMENT_STATUS_LABELS: Record<X402PaymentAttempt['status'], string> = {
  PaymentRequired: 'Payment required',
  Verified: 'Verified',
  Settled: 'Settled',
  Failed: 'Failed',
  Replayed: 'Replayed',
};

export function formatX402PaymentStatus(status: X402PaymentAttempt['status']): string {
  return X402_PAYMENT_STATUS_LABELS[status] ?? formatEnumLabel(status);
}

const X402_WALLET_TYPE_LABELS: Record<X402Wallet['type'], string> = {
  Purchasing: 'Purchasing (outbound)',
  Selling: 'Selling (facilitator)',
};

export function formatX402WalletType(type: X402Wallet['type']): string {
  return X402_WALLET_TYPE_LABELS[type] ?? formatEnumLabel(type);
}

const HYDRA_NODE_STATE_LABELS: Record<string, string> = {
  Running: 'Running',
  Idle: 'Idle',
  Starting: 'Starting',
  Stopping: 'Stopping',
  Stopped: 'Stopped',
};

export function formatHydraNodeState(state: string): string {
  return HYDRA_NODE_STATE_LABELS[state] ?? formatEnumLabel(state);
}

const TRANSACTION_ERROR_TYPE_LABELS: Record<string, string> = {
  NetworkError: 'Network error',
  InsufficientFunds: 'Insufficient funds',
  Unknown: 'Unknown error',
};

export function formatTransactionErrorType(errorType: string | null | undefined): string {
  if (!errorType) return '—';
  return TRANSACTION_ERROR_TYPE_LABELS[errorType] ?? formatEnumLabel(errorType);
}

const HYDRA_ERROR_TYPE_LABELS: Record<string, string> = {
  CommandFailed: 'Command failed',
  PostTxOnChainFailed: 'On-chain submission failed',
  TxInvalid: 'Invalid transaction',
  InvalidInput: 'Invalid input',
};

export function formatHydraErrorType(errorType: string): string {
  return HYDRA_ERROR_TYPE_LABELS[errorType] ?? formatEnumLabel(errorType);
}

export function formatMetadataVersion(version: number | null | undefined): string {
  if (version == null) return '—';
  return `Version ${version}`;
}

export { formatTxStatus } from '@/components/transactions/transaction-format.helpers';
