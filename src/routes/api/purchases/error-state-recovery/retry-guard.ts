import { OnChainState, PurchasingAction, TransactionStatus } from '@/generated/prisma/client';
import createHttpError from 'http-errors';

type RecoveryTransaction = { status: TransactionStatus; txHash: string | null };

export function assertFundsLockingRetryAllowed(
	retryAction: PurchasingAction | null,
	onChainState: OnChainState | null,
	transactions: readonly RecoveryTransaction[],
): void {
	if (retryAction !== PurchasingAction.FundsLockingRequested) return;

	const hasUnresolvedOrConfirmedTransaction = transactions.some(
		(transaction) =>
			transaction.status === TransactionStatus.Confirmed ||
			(transaction.status === TransactionStatus.Pending && transaction.txHash != null),
	);
	if (onChainState != null || hasUnresolvedOrConfirmedTransaction) {
		throw createHttpError(
			409,
			'Funds locking cannot be retried after an escrow state or an unresolved transaction was recorded. Use Repair Request to verify the existing escrow without sending another payment.',
		);
	}
}
