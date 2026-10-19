import { Prisma, TransactionLayer, TransactionStatus } from '@/generated/prisma/client';

/**
 * Escrows this head still holds that have not settled.
 *
 * "Live" means the request still points at an in-head UTxO: an escrow that has
 * reached a terminal state has no `currentHydraUtxoTxHash` and needs nothing
 * further from this wallet. Both sides are counted, because a wallet can be
 * buyer on one escrow and seller on another in the same head. A pending L2
 * reservation counts too: a lock that is accepted but not yet confirmed has no
 * in-head UTxO recorded yet, and is an escrow the moment it confirms.
 */
export async function countLiveInHeadEscrows(tx: Prisma.TransactionClient, hydraHeadId: string): Promise<number> {
	const where = {
		currentHydraUtxoTxHash: { not: null },
		CurrentTransaction: { is: { hydraHeadId, layer: TransactionLayer.L2 } },
	} as const;
	const [payments, purchases, pendingReservations] = await Promise.all([
		tx.paymentRequest.count({ where }),
		tx.purchaseRequest.count({ where }),
		tx.transaction.count({ where: { hydraHeadId, layer: TransactionLayer.L2, status: TransactionStatus.Pending } }),
	]);
	return payments + purchases + pendingReservations;
}
