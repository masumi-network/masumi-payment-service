/**
 * The exact bytes a Hydra party signs when it acks a snapshot.
 *
 * Split out of `snapshot-verification.ts` for size, and because this is the one
 * part of it that is dictated verbatim by upstream: the field order, the CBOR
 * encoding, and the commit slot's outer hash are `Hydra/Tx/Snapshot.hs`, not a
 * choice this service makes. Getting a byte wrong here does not fail loudly —
 * every signature simply stops verifying, which fails a head closed.
 */
import { createHash } from 'node:crypto';

import { HydraProtocolError } from './errors';
import { MAX_HYDRA_SNAPSHOT_OUTPUTS } from './schemas';
import { serializeHydraSnapshotOutput, type SnapshotUtxo } from './snapshot-serialization';
import type { HydraSnapshotVerificationFrame } from './snapshot-verification';

function compareOutputReferences(left: string, right: string): number {
	const [leftHash, leftIndex] = left.split('#');
	const [rightHash, rightIndex] = right.split('#');
	const hashComparison = Buffer.compare(Buffer.from(leftHash, 'hex'), Buffer.from(rightHash, 'hex'));
	if (hashComparison !== 0) return hashComparison;
	return Number(leftIndex) - Number(rightIndex);
}

function hashPendingUtxo(utxo: SnapshotUtxo | null): Buffer {
	const serializedOutputs = Object.entries(utxo ?? {})
		.sort(([left], [right]) => compareOutputReferences(left, right))
		.map(([, output]) => Buffer.from(serializeHydraSnapshotOutput(output), 'hex'));
	return createHash('sha256').update(Buffer.concat(serializedOutputs)).digest();
}

function cborUnsigned(value: number): Buffer {
	if (!Number.isSafeInteger(value) || value < 0)
		throw new HydraProtocolError('Hydra snapshot integer was out of range');
	if (value < 24) return Buffer.from([value]);
	if (value <= 0xff) return Buffer.from([0x18, value]);
	if (value <= 0xffff) {
		const result = Buffer.alloc(3);
		result[0] = 0x19;
		result.writeUInt16BE(value, 1);
		return result;
	}
	if (value <= 0xffffffff) {
		const result = Buffer.alloc(5);
		result[0] = 0x1a;
		result.writeUInt32BE(value, 1);
		return result;
	}
	const result = Buffer.alloc(9);
	result[0] = 0x1b;
	result.writeBigUInt64BE(BigInt(value), 1);
	return result;
}

function cborBytes(bytes: Buffer): Buffer {
	if (bytes.length < 24) return Buffer.concat([Buffer.from([0x40 + bytes.length]), bytes]);
	if (bytes.length <= 0xff) return Buffer.concat([Buffer.from([0x58, bytes.length]), bytes]);
	throw new HydraProtocolError('Hydra signed snapshot byte string exceeded the supported CBOR size');
}

export function hydraSnapshotSignableBytes(frame: HydraSnapshotVerificationFrame): Buffer {
	const snapshot = frame.snapshot;
	const totalOutputCount =
		Object.keys(snapshot.utxo).length +
		Object.keys(snapshot.utxoToCommit ?? {}).length +
		Object.keys(snapshot.utxoToDecommit ?? {}).length;
	if (totalOutputCount > MAX_HYDRA_SNAPSHOT_OUTPUTS) {
		throw new HydraProtocolError(`Hydra snapshot exceeded the ${MAX_HYDRA_SNAPSHOT_OUTPUTS}-output KZG limit`);
	}
	const depositTxId = snapshot.depositTxId ?? null;
	if (depositTxId !== null && !/^[0-9a-f]{64}$/i.test(depositTxId)) {
		throw new HydraProtocolError('Hydra snapshot depositTxId is not a 32-byte hex transaction id');
	}
	// Hydra 2.4 (Hydra/Tx/Snapshot.hs commitOutputsHash): an outer sha256 over
	// hashUTxO(utxoToCommit) ‖ depositTxIdBytes — applied even with no deposit.
	const commitSlot = createHash('sha256')
		.update(
			Buffer.concat([
				hashPendingUtxo(snapshot.utxoToCommit),
				depositTxId ? Buffer.from(depositTxId, 'hex') : Buffer.alloc(0),
			]),
		)
		.digest();
	return Buffer.concat([
		cborBytes(Buffer.from(snapshot.headId, 'hex')),
		cborUnsigned(snapshot.version),
		cborUnsigned(snapshot.number),
		cborBytes(Buffer.from(snapshot.accumulator, 'hex')),
		cborBytes(hashPendingUtxo(snapshot.utxoToDecommit)),
		cborBytes(commitSlot),
	]);
}
