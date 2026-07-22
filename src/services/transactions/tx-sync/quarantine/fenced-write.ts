import { Prisma } from '@/generated/prisma/client';

export type TxSyncBeforeWrite = (tx: Prisma.TransactionClient) => Promise<void>;

export class TxSyncFenceLostError extends Error {
	constructor(paymentSourceId: string) {
		super(`Tx-sync source fence lost for ${paymentSourceId}`);
		this.name = 'TxSyncFenceLostError';
	}
}

/**
 * Atomically verifies ownership and refreshes the existing sync lock through
 * the caller's transaction. PostgreSQL holds the updated source-row lock until
 * that transaction commits, so scanner evidence cannot bump the epoch between
 * this check and the accompanying business writes.
 */
export async function fencePaymentSourceTxSyncVersion(
	tx: Prisma.TransactionClient,
	paymentSourceId: string,
	expectedVersion: number,
): Promise<void> {
	const fenced = await tx.paymentSource.updateMany({
		where: {
			id: paymentSourceId,
			deletedAt: null,
			syncInProgress: true,
			txSyncFenceVersion: expectedVersion,
		},
		// A same-value update deliberately refreshes updatedAt and retains the
		// row lock through commit. This preserves the existing stale-lock timeout.
		data: { syncInProgress: true },
	});
	if (fenced.count !== 1) throw new TxSyncFenceLostError(paymentSourceId);
}

export function createPaymentSourceTxSyncFence(paymentSourceId: string, expectedVersion: number): TxSyncBeforeWrite {
	return async (tx) => await fencePaymentSourceTxSyncVersion(tx, paymentSourceId, expectedVersion);
}

export function isTxSyncFenceLostError(error: unknown): boolean {
	if (error instanceof TxSyncFenceLostError) return true;
	if (error instanceof AggregateError) return error.errors.some(isTxSyncFenceLostError);
	return false;
}
