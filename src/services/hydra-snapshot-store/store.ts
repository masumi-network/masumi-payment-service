import { prisma } from '@masumi/payment-core/db';
import canonicalStringify from 'canonical-json';
import { getOwnString, isPlainObject } from '@masumi/payment-core/object-properties';
import { HydraProtocolError } from '@/lib/hydra/hydra/errors';
import type { HydraSnapshotVerificationFrame } from '@/lib/hydra/hydra/snapshot-verification';

/** Identify the verified signed commitment without unsigned UTxO references. */
export function signedSnapshotIdentityJson(frame: HydraSnapshotVerificationFrame): string {
	return canonicalStringify({
		headId: frame.headId,
		snapshotHeadId: frame.snapshot.headId,
		number: frame.snapshot.number,
		version: frame.snapshot.version,
		accumulator: frame.snapshot.accumulator,
		depositTxId: frame.snapshot.depositTxId ?? null,
		signatures: frame.signatures.multiSignature,
	});
}

/** Keep only the signed state and the party signatures, not unsigned transaction metadata. */
export function signedSnapshotJson(frame: HydraSnapshotVerificationFrame): string {
	const { headId, number, version, accumulator, utxo, utxoToCommit, utxoToDecommit, depositTxId } = frame.snapshot;
	const signedState = {
		headId,
		number,
		version,
		accumulator,
		utxo,
		utxoToCommit,
		utxoToDecommit,
		depositTxId: depositTxId ?? null,
		signatures: frame.signatures.multiSignature,
	};
	// Drop absent optional output fields before canonicalizing key order. The
	// same signed state can arrive with a different JSON object insertion order.
	return canonicalStringify(JSON.parse(JSON.stringify(signedState)));
}

/**
 * Append after signature and accumulator verification. Replay awaits this before
 * it accepts a snapshot, and a conflicting signed commitment then fails the pass.
 * For a snapshot that replay rejects, the write is best effort and only logged. UTxO references are not signed, so a valid
 * redelivery with different references retains the first stored map.
 *
 * Replay rescans the whole history on every reconnect, so a stored row is the
 * common case. It is read first: a failed insert per replayed snapshot costs a
 * second round trip and logs a unique violation on the database server.
 */
export async function persistVerifiedHydraSnapshot(
	hydraHeadId: string,
	frame: HydraSnapshotVerificationFrame,
): Promise<void> {
	const key = {
		hydraHeadId,
		snapshotNumber: BigInt(frame.snapshot.number),
		snapshotVersion: BigInt(frame.snapshot.version),
	};
	const identity = signedSnapshotIdentityJson(frame);
	const findStored = () =>
		prisma.hydraStoredSnapshot.findUnique({
			where: { hydraHeadId_snapshotNumber_snapshotVersion: key },
			select: { headIdentifier: true, signedIdentityJson: true },
		});
	let existing = await findStored();
	if (!existing) {
		try {
			await prisma.hydraStoredSnapshot.create({
				data: {
					...key,
					headIdentifier: frame.headId,
					signedIdentityJson: identity,
					signedSnapshotJson: signedSnapshotJson(frame),
				},
			});
			return;
		} catch (error) {
			if (!isPlainObject(error) || getOwnString(error, 'code') !== 'P2002') throw error;
			existing = await findStored();
		}
	}
	if (existing?.headIdentifier !== frame.headId || existing.signedIdentityJson !== identity) {
		throw new HydraProtocolError(`Hydra snapshot ${frame.snapshot.number} contradicted previously stored signed state`);
	}
}
