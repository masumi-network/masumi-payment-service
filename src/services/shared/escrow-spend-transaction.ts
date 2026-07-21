import { Prisma, TransactionStatus } from '@/generated/prisma/client';
import { createPendingTransaction } from './transition-writer';

type CurrentTransactionSnapshot = {
	id: string;
	txHash: string | null;
	status: TransactionStatus;
} | null;

/**
 * Decides how the pre-submit write should record the outgoing escrow-spend
 * transaction, given the request's CURRENT database state.
 *
 * Two shapes, and the choice must be driven by a fresh read rather than the
 * caller's in-memory `request`:
 *
 *   - First attempt — `CurrentTransaction` is still the confirmed escrow row.
 *     Create a NEW pending row and push the escrow row onto TransactionHistory.
 *     Never mutate the escrow row: blanking its txHash destroys the only
 *     record of the UTxO this request depends on, which is the bug that
 *     wedged refund collection on 'Transaction hash not found'.
 *
 *   - Retry — `CurrentTransaction` is already a pending, hash-less row left by
 *     an earlier attempt in this same `advancedRetryAll` loop. Reuse it.
 *
 * Why the retry branch matters: the services process each request inside
 * `advancedRetryAll` with `maxRetries: 5`, and the closed-over `request`
 * object is NOT refetched between attempts, so its `CurrentTransaction` still
 * points at the escrow row on every attempt. Unconditionally creating would
 * therefore mint a fresh row per attempt and move
 * `HotWallet.pendingTransactionId` to it, leaving the previous attempt's row
 * as neither CurrentTransaction, nor TransactionHistory, nor BlocksWallet —
 * unreachable by wallet-timeouts, by the request-level sweep, and by
 * `reconcileAmbiguousFundingV2` (which requires `intendedTxHash != null`,
 * never set on V1). Those rows would sit Pending forever.
 *
 * The reuse branch deliberately does not re-connect the escrow row to
 * TransactionHistory — the first attempt already did, and `connect` on an
 * implicit m-n is idempotent anyway.
 */
export function resolveEscrowSpendTransactionWrite(
	currentTransaction: CurrentTransactionSnapshot,
	blocksWalletId: string,
	escrowTransactionId: string,
) {
	const isReusablePendingRow =
		currentTransaction != null &&
		currentTransaction.id !== escrowTransactionId &&
		currentTransaction.txHash == null &&
		currentTransaction.status === TransactionStatus.Pending;

	if (isReusablePendingRow) {
		return {
			CurrentTransaction: {
				update: {
					status: TransactionStatus.Pending,
					// Refresh so wallet-timeouts debounces from THIS attempt, not the first.
					lastCheckedAt: new Date(),
					BlocksWallet: {
						connect: { id: blocksWalletId },
					},
				},
			},
		} satisfies Pick<Prisma.PaymentRequestUpdateInput, 'CurrentTransaction'>;
	}

	return {
		...createPendingTransaction(blocksWalletId),
		TransactionHistory: {
			connect: { id: escrowTransactionId },
		},
	};
}
