/**
 * Turn hydra-node's `GET /snapshot` answer (a `ConfirmedSnapshot`) into the
 * proof a co-signer can check. Quantities become decimal strings so no JSON
 * stack on either side rounds them, and only the fields the hashes read are kept.
 */
import {
	getOwnEntries,
	getOwnPlainObject,
	getOwnString,
	getOwnValue,
	isPlainObject,
	type RuntimeObject,
} from '@masumi/payment-core/object-properties';
import type { HydraSnapshotProof, SnapshotTxOut, SnapshotUTxO } from './snapshot-proof';

function quantityString(value: unknown, label: string): string {
	if (typeof value === 'bigint' && value >= 0n) return value.toString();
	if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value.toString();
	if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) return value;
	throw new Error(`Snapshot ${label} is not a non-negative integer`);
}

function wholeNumber(value: unknown, label: string): number {
	const asString = quantityString(value, label);
	const parsed = Number(asString);
	if (!Number.isSafeInteger(parsed)) throw new Error(`Snapshot ${label} is too large`);
	return parsed;
}

function txOut(ref: string, raw: RuntimeObject): SnapshotTxOut {
	const address = getOwnString(raw, 'address');
	const rawValue = getOwnPlainObject(raw, 'value');
	if (address == null || rawValue == null) throw new Error(`Snapshot output ${ref} has no address or value`);
	const value: SnapshotTxOut['value'] = {};
	for (const [key, entry] of getOwnEntries(rawValue)) {
		if (key === 'lovelace') {
			value.lovelace = quantityString(entry, `${ref} lovelace`);
			continue;
		}
		if (!isPlainObject(entry)) throw new Error(`Snapshot output ${ref} policy ${key} has no asset map`);
		value[key] = Object.fromEntries(
			getOwnEntries(entry).map(([name, amount]) => [name, quantityString(amount, `${ref} ${key}.${name}`)]),
		);
	}
	// Its Plutus form carries the script hash, which this proof does not compute.
	if (getOwnValue(raw, 'referenceScript') != null) {
		throw new Error(`Snapshot output ${ref} carries a reference script, which the proof cannot cover`);
	}
	return {
		address,
		value,
		datumhash: getOwnString(raw, 'datumhash') ?? null,
		inlineDatumRaw: getOwnString(raw, 'inlineDatumRaw') ?? null,
	};
}

function utxoSet(raw: RuntimeObject | undefined): SnapshotUTxO | null {
	if (raw == null) return null;
	const set: SnapshotUTxO = {};
	for (const [ref, output] of getOwnEntries(raw)) {
		if (!isPlainObject(output)) throw new Error(`Snapshot output ${ref} is not an object`);
		set[ref] = txOut(ref, output);
	}
	return set;
}

export function toHydraSnapshotProof(confirmed: unknown): HydraSnapshotProof {
	if (!isPlainObject(confirmed)) throw new Error('The node returned no confirmed snapshot');
	const snapshot = getOwnPlainObject(confirmed, 'snapshot');
	const signatures = getOwnValue(getOwnPlainObject(confirmed, 'signatures') ?? {}, 'multiSignature');
	if (snapshot == null || !Array.isArray(signatures) || !signatures.every((s) => typeof s === 'string')) {
		throw new Error('The node returned a snapshot without signatures');
	}
	const headId = getOwnString(snapshot, 'headId');
	const accumulator = getOwnString(snapshot, 'accumulator');
	const utxo = utxoSet(getOwnPlainObject(snapshot, 'utxo'));
	if (headId == null || accumulator == null || utxo == null) {
		throw new Error('The snapshot has no head id, accumulator or UTxO set');
	}
	return {
		headId,
		version: wholeNumber(getOwnValue(snapshot, 'version'), 'version'),
		number: wholeNumber(getOwnValue(snapshot, 'number'), 'number'),
		accumulator,
		utxo,
		utxoToCommit: utxoSet(getOwnPlainObject(snapshot, 'utxoToCommit')),
		utxoToDecommit: utxoSet(getOwnPlainObject(snapshot, 'utxoToDecommit')),
		depositTxId: getOwnString(snapshot, 'depositTxId') ?? null,
		signatures,
	};
}
