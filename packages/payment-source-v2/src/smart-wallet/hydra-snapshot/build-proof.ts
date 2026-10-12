/**
 * Turn hydra-node's `GET /snapshot` answer (a `ConfirmedSnapshot`) into the
 * proof a co-signer can check for one wallet output: the signed header, the
 * output, and its KZG membership witness over the head's whole UTxO set.
 * Quantities become decimal strings so no JSON stack on either side rounds
 * them, and only the fields the hashes read are kept.
 */
import { computeHydraMembershipWitness } from '@/lib/hydra/hydra/snapshot-accumulator';
import { hydraSnapshotUtxoSchema } from '@/lib/hydra/hydra/schemas';
import { canonicalSnapshotOutputs } from '@/lib/hydra/hydra/snapshot-verification';
import {
	getOwnEntries,
	getOwnPlainObject,
	getOwnString,
	getOwnValue,
	isPlainObject,
	type RuntimeObject,
} from '@masumi/payment-core/object-properties';
import {
	serializeSnapshotTxOut,
	type HydraSnapshotProof,
	type SnapshotTxOut,
	type SnapshotUTxO,
} from './snapshot-proof';

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

/**
 * The proof that `walletUtxoRef` is in the confirmed snapshot. Throws when the
 * snapshot does not hold it in `utxo` or `utxoToCommit`.
 */
export function toHydraSnapshotProof(confirmed: unknown, walletUtxoRef: string): HydraSnapshotProof {
	if (!isPlainObject(confirmed)) throw new Error('The node returned no confirmed snapshot');
	const snapshot = getOwnPlainObject(confirmed, 'snapshot');
	const signatures = getOwnValue(getOwnPlainObject(confirmed, 'signatures') ?? {}, 'multiSignature');
	if (snapshot == null || !Array.isArray(signatures) || !signatures.every((s) => typeof s === 'string')) {
		throw new Error('The node returned a snapshot without signatures');
	}
	const headId = getOwnString(snapshot, 'headId');
	const accumulator = getOwnString(snapshot, 'accumulator');
	const rawUtxo = getOwnPlainObject(snapshot, 'utxo');
	if (headId == null || accumulator == null || rawUtxo == null) {
		throw new Error('The snapshot has no head id, accumulator or UTxO set');
	}
	const rawCommit = getOwnPlainObject(snapshot, 'utxoToCommit');
	const rawDecommit = getOwnPlainObject(snapshot, 'utxoToDecommit');
	const ref = walletUtxoRef.toLowerCase();
	const rawWallet =
		getOwnPlainObject(rawUtxo, ref) ?? (rawCommit == null ? undefined : getOwnPlainObject(rawCommit, ref));
	if (rawWallet == null) throw new Error('The latest confirmed snapshot does not hold the guarded wallet UTxO');
	const walletOutput = txOut(ref, rawWallet);
	const version = wholeNumber(getOwnValue(snapshot, 'version'), 'version');
	const number = wholeNumber(getOwnValue(snapshot, 'number'), 'number');
	const depositTxId = getOwnString(snapshot, 'depositTxId') ?? null;

	// Every output of the head, in the exact bytes the accumulator hashes.
	const outputs = canonicalSnapshotOutputs({
		headId,
		version,
		number,
		accumulator,
		confirmed: [],
		utxo: hydraSnapshotUtxoSchema.parse(rawUtxo),
		utxoToCommit: rawCommit == null ? null : hydraSnapshotUtxoSchema.parse(rawCommit),
		utxoToDecommit: rawDecommit == null ? null : hydraSnapshotUtxoSchema.parse(rawDecommit),
		depositTxId,
	});
	const member = outputs.get(ref);
	// The verifier serializes the proof's copy; it must be the bytes the head signed.
	if (member == null || serializeSnapshotTxOut(walletOutput) !== member) {
		throw new Error('The wallet output in the proof does not serialize to its snapshot bytes');
	}
	const { commitment, witness } = computeHydraMembershipWitness(outputs.values(), member);
	return {
		headId,
		version,
		number,
		accumulator,
		commitment,
		witness,
		walletOutput,
		utxoToCommit: utxoSet(rawCommit),
		utxoToDecommit: utxoSet(rawDecommit),
		depositTxId,
		signatures,
	};
}
