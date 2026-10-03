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
