import { HydraProtocolError } from './errors';
import { historySnapshotConfirmedMessageSchema } from './schemas';
import type { VerifiedHydraSnapshot } from './snapshot-verification';

type HistorySnapshotMessage = ReturnType<typeof historySnapshotConfirmedMessageSchema.parse>;
type LastSignedFrame = { version: number; accumulator: string; signatures: string };

/**
 * A node side-load can re-emit the same signed snapshot. Signatures and the
 * accumulator have already been verified for this delivery before this check.
 * An equal number with different signed content is still a regression.
 * `confirmed` is unsigned metadata, so it is not part of this identity check.
 * Replay ignores all metadata from an identical repeat. A changed `confirmed`
 * list on such a repeat is therefore not detected, but is also not adopted.
 */
export function isIdenticalSignedSnapshotRedelivery(
	previous: VerifiedHydraSnapshot,
	last: LastSignedFrame | undefined,
	message: HistorySnapshotMessage,
	verified: VerifiedHydraSnapshot,
): boolean {
	return (
		last != null &&
		verified.number === previous.number &&
		verified.version === last.version &&
		message.snapshot.accumulator === last.accumulator &&
		JSON.stringify(message.signatures.multiSignature) === last.signatures
	);
}

/**
 * Hydra's opening frame has no UTxO anchor. The service opens every head empty:
 * `validateHydraCommitDraft` requires the deposit-script output shape, which
 * hydra-node produces only after Open. Thus no initial commit is signed and
 * snapshot 1 can only declare a deposit with no confirmed transactions.
 * Supporting initial commits requires an independent opening anchor first.
 */
export function assertSafeFirstHistorySnapshot(message: HistorySnapshotMessage, verified: VerifiedHydraSnapshot): void {
	if (verified.number > 1 || message.snapshot.confirmed.length > 0) {
		throw new HydraProtocolError(
			'Hydra history began with transactions or a snapshot gap and no independently verified predecessor',
		);
	}
}
