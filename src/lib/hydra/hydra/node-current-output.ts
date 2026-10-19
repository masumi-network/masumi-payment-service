import { HydraHeadStatus } from '@/generated/prisma/client';
import type { VerifiedHydraSnapshot } from './snapshot-verification';

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
