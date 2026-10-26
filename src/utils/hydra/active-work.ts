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
import createHttpError from 'http-errors';

/**
 * A deposit that reached L1 and has neither been taken by the head nor sent
 * back. The single definition, shared with the deletion guard.
 *
 * Three endings mean no money is waiting at the deposit script, and `Failed` is
 * one of them, however much it reads like the opposite. Only two writers set it
 * with a deposit hash attached, and both prove the deposit's output does not
 * exist: `confirmed-invalid` is a phase-2 failure, which creates no outputs at
 * all, and the other branch fires only once a trusted current slot is past the
 * signed TTL plus the rollback grace with the hash still absent from L1 — after
 * which that transaction can never be included. The status's own definition
 * says as much: "rejected/absent past its validity window; retry is safe".
 *
 * Counting it anyway made every failed top-up permanent: the head, its
 * participants and their relations could not be deleted, and nothing could ever
 * clear the row, because `reconcileRecoveredHydraTopups` resolves a deposit only
 * by watching its output be spent and an output that was never created is never
 * spent. That reconciler still watches Failed rows, so a verdict that turns out
 * wrong is still corrected while the head exists — which is the right place for
 * that doubt, rather than in a guard with no way out.
 *
 * Stated as an exclusion rather than an allow-list: a status added later should
 * block a delete until someone has thought about it, not slip past this.
 *
 * The deposit UI reads the same status differently — it still offers Recover on
 * a Failed row, on the grounds that a lagging or rolled-back chain view looks
 * exactly like an absence — and that is not a contradiction, because the two
 * answer for different points in a head's life. Recover needs a live node
 * session for the head, and every delete path here is gated on
 * `reconciledFinalHeadFilter`: Final, disabled, fanned out and reconciled. By
 * then there is no session to ask, so keeping the row would not keep the
 * remedy. While the head is live, the row is there and Recover is offered.
 */
export const unrecoveredHydraTopupWhere = {
	depositTxHash: { not: null },
	status: { notIn: [HydraTopupStatus.Absorbed, HydraTopupStatus.Recovered, HydraTopupStatus.Failed] },
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
 * Older releases could submit an initial commit before writing its recovery
 * row. Confirmation does not prove absorption, so a missing row stays active
 * even after hasCommitted becomes true. New reservations create both atomically.
 */
async function countUnrecordedInitialCommit(client: Prisma.TransactionClient, headId: string): Promise<number> {
	const participant = await client.hydraLocalParticipant.findFirst({
		where: { hydraHeadId: headId, commitTxHash: { not: null } },
		select: { id: true, commitTxHash: true },
	});
	if (participant?.commitTxHash == null) return 0;
	const recorded = await client.hydraTopup.count({
		where: {
			hydraHeadId: headId,
			hydraLocalParticipantId: participant.id,
			depositTxHash: participant.commitTxHash,
			isInitialCommit: true,
		},
	});
	return recorded === 0 ? 1 : 0;
}

/** A missing recovery record cannot be waived as ordinary active escrow work. */
export async function assertHydraCommitRecoveryRecorded(
	client: Prisma.TransactionClient,
	headId: string,
): Promise<void> {
	if ((await countUnrecordedInitialCommit(client, headId)) !== 0) {
		throw createHttpError(
			409,
			'Cannot close or delete: an initial Hydra commit has no recovery record. ' +
				'Restore its recovery record from verified deposit evidence before retrying',
		);
	}
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
