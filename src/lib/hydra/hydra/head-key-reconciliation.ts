import { HydraHeadStatus } from '@/generated/prisma/client';

export type HydraHeadKeyReconciliationState = {
	status: HydraHeadStatus;
	isEnabled: boolean;
	headIdentifier: string | null;
	initTxHash: string | null;
	closeTxHash: string | null;
	fanoutTxHash: string | null;
	openedAt: Date | null;
	closedAt: Date | null;
	finalizedAt: Date | null;
	contestationDeadline: Date | null;
	latestSnapshotNumber: bigint;
	lastReconciledSnapshotSequence: bigint | null;
	lastReconciledSnapshotTransactionIndex: number | null;
	reconciliationCompletedAt: Date | null;
	isClosing: boolean;
	transactionCount: number;
	errorCount: number;
	localParticipant: {
		hasCommitted: boolean;
		commitTxHash: string | null;
		commitInvalidHereafterSlot: bigint | null;
	} | null;
	remoteParticipants: ReadonlyArray<{
		hasCommitted: boolean;
		commitTxHash: string | null;
	}>;
};

/**
 * Key replacement is safe only before a head has produced any durable protocol
 * evidence. In particular, never make an unsafe row appear pristine by clearing
 * lifecycle hashes, finalization markers, replay cursors, or commit evidence.
 */
export function isHydraHeadKeyReconciliationEligible(state: HydraHeadKeyReconciliationState): boolean {
	return (
		state.status === HydraHeadStatus.Idle &&
		!state.isEnabled &&
		state.headIdentifier === null &&
		state.initTxHash === null &&
		state.closeTxHash === null &&
		state.fanoutTxHash === null &&
		state.openedAt === null &&
		state.closedAt === null &&
		state.finalizedAt === null &&
		state.contestationDeadline === null &&
		state.latestSnapshotNumber === 0n &&
		state.lastReconciledSnapshotSequence === null &&
		state.lastReconciledSnapshotTransactionIndex === null &&
		state.reconciliationCompletedAt === null &&
		!state.isClosing &&
		state.transactionCount === 0 &&
		state.errorCount === 0 &&
		state.localParticipant !== null &&
		!state.localParticipant.hasCommitted &&
		state.localParticipant.commitTxHash === null &&
		state.localParticipant.commitInvalidHereafterSlot === null &&
		state.remoteParticipants.length === 1 &&
		state.remoteParticipants.every((participant) => !participant.hasCommitted && participant.commitTxHash === null)
	);
}
