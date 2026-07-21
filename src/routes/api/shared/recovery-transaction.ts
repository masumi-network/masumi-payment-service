import { TransactionStatus } from '@/generated/prisma/client';

type RecoveryTransactionCandidate = {
	id: string;
	txHash: string | null;
	status: TransactionStatus;
};

/**
 * Picks the transaction that `error-state-recovery` should re-pin as the
 * request's CurrentTransaction.
 *
 * A row without a txHash is never a valid target. The retried action reads
 * `CurrentTransaction.txHash` to locate its escrow UTxO, so re-pinning a
 * hash-less row fails immediately with 'Transaction hash not found' — and
 * because the selected row is excluded from `transactionsToFail`, it is never
 * cleared either, so every subsequent retry reproduces the same error. That
 * loop is exactly what wedged refund collection.
 *
 * `transactionHistory` arrives ordered newest-first.
 */
export function selectRecoveryTransaction<T extends RecoveryTransactionCandidate>(
	transactionHistory: T[],
): T | undefined {
	const hasUsableHash = (tx: T) => tx.txHash != null;

	// Priority 1: most recent Confirmed transaction (fully successful).
	const confirmed = transactionHistory.filter((tx) => tx.status === TransactionStatus.Confirmed && hasUsableHash(tx));
	if (confirmed.length > 0) return confirmed[0];

	// Priority 2: most recent Pending transaction (in progress).
	const pending = transactionHistory.filter((tx) => tx.status === TransactionStatus.Pending && hasUsableHash(tx));
	return pending.length > 0 ? pending[0] : undefined;
}
