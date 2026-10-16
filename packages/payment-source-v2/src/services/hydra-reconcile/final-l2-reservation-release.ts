/**
 * Releasing Pending L2 reservations that a Final head left behind.
 *
 * The final handoff refuses to complete while any L2 row of the head is still
 * Pending, and the open head release path cannot help once the head is Final:
 * it waits for a snapshot newer than its baseline, and a Final head makes none.
 * An operator may close a head with work still in flight, so without this step
 * such a row blocks reconciliation until a manual database repair.
 *
 * The proof is `isL2ReservationDeadInFinalSnapshot`, read against the verified
 * final snapshot only after its fanout was verified on chain. The release
 * itself is `releaseRejectedL2Reservation`, which re-reads and guards the row.
 */

import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { TransactionLayer, TransactionStatus } from '@/generated/prisma/client';
import type { VerifiedHydraFanoutReference } from '@/lib/hydra/hydra/snapshot-verification';
import type { HydraNode } from '@/lib/hydra/hydra/node';
import { isL2ReservationDeadInFinalSnapshot } from './l2-reservation-release-decision';
import { releaseRejectedL2Reservation } from './l2-reservation-release';
import { escrowPointerSelect, reservationInputRefs } from './l2-reservation-recovery';

/** Returns how many reservations were released. */
export async function releaseFinalHeadL2Reservations(params: {
	hydraHeadId: string;
	/** The head's DB `latestSnapshotNumber`: the snapshot the fanout must match. */
	expectedSnapshotNumber: number;
	node: HydraNode;
	/** Throws unless the fanout of these references is confirmed on chain. */
	verifyFanoutOnChain: (references: readonly VerifiedHydraFanoutReference[]) => Promise<unknown>;
	database?: typeof prisma;
}): Promise<number> {
	const { hydraHeadId, expectedSnapshotNumber, node, verifyFanoutOnChain, database = prisma } = params;
	const candidates = await database.transaction.findMany({
		where: { hydraHeadId, layer: TransactionLayer.L2, status: TransactionStatus.Pending },
		select: {
			id: true,
			intendedTxHash: true,
			l2ReservationInputRefs: true,
			l2ReleaseNudgeInputRef: true,
			l2ReservationPreviousLayer: true,
			l2ReservationPreviousSmartContractWalletId: true,
			l2ReservationPreviousBuyerReturnAddress: true,
			l2ReservationPreviousCollateralReturn: true,
			l2ReservationPreviousTransactionId: true,
			PaymentRequestCurrent: { select: escrowPointerSelect },
			PurchaseRequestCurrent: { select: escrowPointerSelect },
		},
	});
	const references = candidates.length === 0 ? null : node.getVerifiedFanoutReferences(expectedSnapshotNumber);
	if (!references) return 0;
	const dead = candidates.filter(
		(candidate) =>
			// A body the history confirmed is for ordered replay to apply, not to undo.
			!(candidate.intendedTxHash != null && node.getConfirmedTransaction(candidate.intendedTxHash)) &&
			isL2ReservationDeadInFinalSnapshot({
				inputRefs: reservationInputRefs(candidate),
				readFinalOutput: (reference) => node.getVerifiedFinalOutput(reference, expectedSnapshotNumber),
			}),
	);
	// The chain check runs only when it can lead to a release, so a held row does
	// not cost an observer pass on every reconcile.
	if (dead.length === 0) return 0;
	await verifyFanoutOnChain(references);

	let released = 0;
	for (const candidate of dead) {
		if (!(await releaseRejectedL2Reservation(candidate, database, 'inputs-unspent-in-final-snapshot'))) continue;
		released += 1;
		logger.warn('[HydraReconcile] released L2 reservation: every input unspent in the fanned-out final snapshot', {
			hydraHeadId,
			transactionId: candidate.id,
			intendedTxHash: candidate.intendedTxHash,
			snapshotNumber: expectedSnapshotNumber,
		});
	}
	return released;
}
