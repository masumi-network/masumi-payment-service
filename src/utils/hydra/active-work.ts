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
import { PREPARING_STALE_AFTER_MS } from '@/services/hydra-topup/stale';

/** Historical terminal labels require an independently confirmed consumer. */
export const unprovenHydraSettlementWhere = {
	status: { in: [HydraTopupStatus.Absorbed, HydraTopupStatus.Recovered] },
	settlementTxHash: null,
} satisfies Prisma.HydraTopupWhereInput;

/** Failed means no deposit output exists; it has no Claim/Recover consumer. */
export const unrecoveredHydraTopupWhere = {
	OR: [
		{
			depositTxHash: { not: null },
			status: { notIn: [HydraTopupStatus.Absorbed, HydraTopupStatus.Recovered, HydraTopupStatus.Failed] },
		},
		unprovenHydraSettlementWhere,
	],
} satisfies Prisma.HydraTopupWhereInput;

/** Work that survives into L1 if the head is closed now. */
export type HydraHeadActiveWork = {
	/** L2 transactions submitted to the head that have not been confirmed in a snapshot. */
	pendingL2Transactions: number;
	/** In-head escrows still holding funds, across both sides of the trade. */
	activeEscrows: number;
	/**
	 * Deposits at the L1 deposit script that the head has neither absorbed nor
	 * returned, plus deposits this service is still preparing or has reserved
	 * but not yet recorded: a close admitted now would let them land after it.
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

/**
 * An initial commit is reserved on the participant before it is submitted, and
 * gets its deposit row only after. Counted from the reservation until that row
 * exists, so a close in between still sees it, and never twice.
 */
async function countUnrecordedInitialCommit(client: Prisma.TransactionClient, headId: string): Promise<number> {
	const participant = await client.hydraLocalParticipant.findFirst({
		where: { hydraHeadId: headId, hasCommitted: false, commitTxHash: { not: null } },
		select: { commitTxHash: true },
	});
	if (participant?.commitTxHash == null) return 0;
	const recorded = await client.hydraTopup.count({
		where: { hydraHeadId: headId, depositTxHash: participant.commitTxHash },
	});
	return recorded === 0 ? 1 : 0;
}

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
	const topupsInFlight = await client.hydraTopup.count({
		where: {
			hydraHeadId: headId,
			OR: [
				unrecoveredHydraTopupWhere,
				// Not at the script yet, but on its way: the carve may already be on
				// L1 and the deposit follows it. A stale row is one whose process died;
				// the next top-up fails it, and it must not block a close forever.
				{
					status: HydraTopupStatus.Preparing,
					createdAt: { gte: new Date(Date.now() - PREPARING_STALE_AFTER_MS) },
				},
			],
		},
	});
	const unrecordedInitialCommit = await countUnrecordedInitialCommit(client, headId);

	return {
		pendingL2Transactions,
		activeEscrows: activePaymentEscrows + activePurchaseEscrows,
		unrecoveredDeposits: topupsInFlight + unrecordedInitialCommit,
	};
}

/** Whether closing now would push anything onto L1. */
export function hasActiveWork(work: HydraHeadActiveWork): boolean {
	return work.pendingL2Transactions > 0 || work.activeEscrows > 0 || work.unrecoveredDeposits > 0;
}
