/**
 * What a head is still holding, counted the same way wherever it is asked.
 *
 * Two callers need this answer and they have to agree: the close endpoint,
 * which refuses an unacknowledged close while work remains, and the readiness
 * endpoint, which is what lets the UI ask the question *before* the operator
 * presses anything. When each counted for itself, the dialog could offer a
 * plain close for a head the API was about to refuse.
 *
 * Takes the client rather than importing one, so it runs inside the close
 * admission's serializable transaction — where the counts have to be read under
 * the same row lock as the claim — and against the plain client everywhere else.
 */

import { HydraTopupStatus, type Prisma, TransactionLayer, TransactionStatus } from '@/generated/prisma/client';

/**
 * A deposit that reached L1 and has neither been taken by the head nor sent
 * back. The single definition, shared with the deletion guard.
 */
export const unrecoveredHydraTopupWhere = {
	depositTxHash: { not: null },
	status: { notIn: [HydraTopupStatus.Absorbed, HydraTopupStatus.Recovered] },
} satisfies Prisma.HydraTopupWhereInput;

/** Work that survives into L1 if the head is closed now. */
export type HydraHeadActiveWork = {
	/** L2 transactions submitted to the head that have not been confirmed in a snapshot. */
	pendingL2Transactions: number;
	/** In-head escrows still holding funds, across both sides of the trade. */
	activeEscrows: number;
	/**
	 * Deposits at the L1 deposit script that the head has neither absorbed nor
	 * returned.
	 *
	 * Unlike the other two, closing does NOT settle these: an unabsorbed deposit
	 * is not part of the fanout. It comes back only through Recover, which the
	 * node can only be asked for while this service still has a session for the
	 * head — so a close waved through here strands the money.
	 */
	unrecoveredDeposits: number;
};

/**
 * An escrow counts as active while it still points at an in-head output, or
 * while its terminal transaction has not been resolved — either way there is
 * value in the head that closing moves to L1.
 */
const activeEscrowWhere = (headId: string) => ({
	layer: TransactionLayer.L2,
	CurrentTransaction: { is: { hydraHeadId: headId, layer: TransactionLayer.L2 } },
	OR: [
		{
			currentHydraUtxoTxHash: { not: null },
			currentHydraUtxoOutputIndex: { not: null },
		},
		{ unresolvedHydraTerminalTxHash: { not: null } },
	],
});

export async function countHydraHeadActiveWork(
	client: Prisma.TransactionClient,
	headId: string,
): Promise<HydraHeadActiveWork> {
	const pendingL2Transactions = await client.transaction.count({
		where: {
			hydraHeadId: headId,
			layer: TransactionLayer.L2,
			status: TransactionStatus.Pending,
		},
	});
	const activePaymentEscrows = await client.paymentRequest.count({ where: activeEscrowWhere(headId) });
	const activePurchaseEscrows = await client.purchaseRequest.count({ where: activeEscrowWhere(headId) });
	const unrecoveredDeposits = await client.hydraTopup.count({
		where: { hydraHeadId: headId, ...unrecoveredHydraTopupWhere },
	});

	return {
		pendingL2Transactions,
		activeEscrows: activePaymentEscrows + activePurchaseEscrows,
		unrecoveredDeposits,
	};
}

/** Whether closing now would push anything onto L1. */
export function hasActiveWork(work: HydraHeadActiveWork): boolean {
	return work.pendingL2Transactions > 0 || work.activeEscrows > 0 || work.unrecoveredDeposits > 0;
}
