import { HydraHeadStatus } from '@/generated/prisma/client';
import type { VerifiedHydraSnapshot } from './snapshot-verification';

/** A live close ahead of history makes the replayed close unsafe to publish. */
export function readCurrentClosedSnapshot(
	verified: boolean,
	replayedClosed: number | undefined,
	liveClosed: number | undefined,
): bigint | undefined {
	if (!verified || replayedClosed === undefined || (liveClosed !== undefined && liveClosed !== replayedClosed)) {
		return undefined;
	}
	return BigInt(replayedClosed);
}

export function readVerifiedCurrentOutput(
	verified: boolean,
	status: HydraHeadStatus,
	snapshot: VerifiedHydraSnapshot | undefined,
	reference: string,
	expectedSnapshotNumber: bigint,
): string | null {
	if (!verified || status !== HydraHeadStatus.Open || !snapshot || BigInt(snapshot.number) !== expectedSnapshotNumber) {
		return null;
	}
	// The accumulator also includes pending deposits and withdrawals. Neither
	// partition is an available escrow in the head's spendable UTxO set.
	if (snapshot.committedOutputs.has(reference) || snapshot.decommitOutputs.has(reference)) return null;
	return snapshot.outputs.get(reference) ?? null;
}

/**
 * Whether the verified snapshot holds `reference` as a deposit still being
 * folded in (`utxoToCommit`). Such an output is not spent: it becomes ordinary
 * state in the next signed snapshot, and on an idle head only a new
 * transaction produces that snapshot.
 */
export function isVerifiedPendingCommitOutput(
	verified: boolean,
	status: HydraHeadStatus,
	snapshot: VerifiedHydraSnapshot | undefined,
	reference: string,
	expectedSnapshotNumber: bigint,
): boolean {
	if (!verified || status !== HydraHeadStatus.Open || !snapshot || BigInt(snapshot.number) !== expectedSnapshotNumber) {
		return false;
	}
	return snapshot.committedOutputs.has(reference);
}

/**
 * The verified snapshot a finalized head fanned out, when it is the one the
 * caller expects. Null on any other session, status or snapshot number.
 */
export function readFinalSnapshot(
	verified: boolean,
	status: HydraHeadStatus,
	snapshot: VerifiedHydraSnapshot | undefined,
	expectedSnapshotNumber: number,
): VerifiedHydraSnapshot | null {
	if (
		!verified ||
		status !== HydraHeadStatus.Final ||
		!Number.isSafeInteger(expectedSnapshotNumber) ||
		expectedSnapshotNumber < 0 ||
		snapshot?.number !== expectedSnapshotNumber
	) {
		return null;
	}
	return snapshot;
}
