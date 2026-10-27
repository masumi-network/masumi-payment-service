import { prisma } from '@masumi/payment-core/db';
import canonicalStringify from 'canonical-json';
import { getOwnString, isPlainObject } from '@masumi/payment-core/object-properties';
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
 * Append after verification and before replay accepts the snapshot. A conflicting
 * signed commitment fails closed. UTxO references are not signed, so a valid
 * redelivery with different references retains the first stored map.
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
	const serialized = signedSnapshotJson(frame);
	const identity = signedSnapshotIdentityJson(frame);
	try {
		await prisma.hydraStoredSnapshot.create({
			data: {
				...key,
				headIdentifier: frame.headId,
				signedIdentityJson: identity,
				signedSnapshotJson: serialized,
			},
		});
	} catch (error) {
		if (!isPlainObject(error) || getOwnString(error, 'code') !== 'P2002') throw error;
		const existing = await prisma.hydraStoredSnapshot.findUnique({
			where: { hydraHeadId_snapshotNumber_snapshotVersion: key },
			select: { headIdentifier: true, signedIdentityJson: true },
		});
		if (existing?.headIdentifier !== frame.headId || existing.signedIdentityJson !== identity) {
			throw new Error(`Hydra snapshot ${frame.snapshot.number} contradicted previously stored signed state`);
		}
	}
}
