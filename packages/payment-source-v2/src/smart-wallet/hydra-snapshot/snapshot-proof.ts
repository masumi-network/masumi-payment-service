/**
 * Proof that a guarded wallet output exists in a Hydra head, checkable by anyone
 * who knows the head's party keys (they are in the head's state datum on L1).
 *
 * The proof is the signed header of hydra-node's latest confirmed snapshot, the
 * wallet output, and a KZG membership witness for it. Every party signs the
 * accumulator, a hash of the commitment C to all outputs of the head; the
 * witness shows the wallet output is one of them (`verifyHydraMembership`), so
 * the rest of the head's UTxO set stays with the node. The small pending sets
 * (`utxoToCommit`, `utxoToDecommit`) are sent whole, because the signature
 * covers them through their hashes. Quantities are decimal strings so no JSON
 * stack on either side rounds them.
 *
 * What a valid proof shows: every party agreed the head holds this output
 * content. It does NOT bind an output reference (`txId#index`): the accumulator
 * hashes outputs only. The output is the wallet's because it carries the
 * wallet's state token, which only one output can hold. Whether that output is
 * still unspent, and whether the snapshot is the newest, are for the head
 * ledger and the co-signer's own records.
 */
import { verifyHydraMembership } from '@/lib/hydra/hydra/snapshot-membership';
import {
	serializeHydraSnapshotOutput,
	verifyHydraSnapshotSignatures,
	type HydraSnapshotVerificationFrame,
	type SnapshotOutput,
	type SnapshotUtxo,
} from '@/lib/hydra/hydra/snapshot-verification';
import type { HydraValue } from '@/lib/hydra/hydra/types';
import { Data } from 'lucid-cardano';

/** One output as the payment node sends it: hydra-node's JSON, quantities as decimal strings. */
export type SnapshotTxOut = {
	address: string;
	value: Record<string, string | Record<string, string>>;
	datumhash?: string | null;
	inlineDatumRaw?: string | null;
};

export type SnapshotUTxO = Record<string, SnapshotTxOut>;

/** A confirmed snapshot's signed header, the wallet output and its membership witness. */
export type HydraSnapshotProof = {
	headId: string;
	version: number;
	number: number;
	accumulator: string;
	/** C, the compressed G1 commitment to every output; its blake2b-256 is `accumulator`. */
	commitment: string;
	/** π, the compressed G1 witness that `walletOutput` is one of C's outputs. */
	witness: string;
	walletOutput: SnapshotTxOut;
	utxoToCommit: SnapshotUTxO | null;
	utxoToDecommit: SnapshotUTxO | null;
	depositTxId: string | null;
	/** Ed25519 signatures (hex), in the order of the head's parties. */
	signatures: string[];
};

/** Canonical form only (lowercase hex, no leading zeros), so one output has one spelling. */
function parseTxIn(ref: string): { txId: string; index: number } {
	const match = /^([0-9a-f]{64})#(0|[1-9]\d{0,4})$/.exec(ref);
	if (match == null) throw new Error(`Invalid output reference "${ref}"`);
	return { txId: match[1], index: Number(match[2]) };
}

function quantity(raw: string): bigint {
	if (!/^(0|[1-9]\d*)$/.test(raw)) throw new Error(`Invalid quantity "${raw}"`);
	return BigInt(raw);
}

function hexField(raw: string | null | undefined, pattern: RegExp, label: string): string | null {
	if (raw == null) return null;
	if (!pattern.test(raw)) throw new Error(`Invalid ${label}`);
	return raw;
}

/** The bytes the serializer signs: lucid's re-encoding, which drops trailing and non-minimal CBOR. */
function canonicalDatum(raw: string | null): string | null {
	if (raw == null) return null;
	try {
		return Data.to(Data.from(raw));
	} catch {
		throw new Error('Invalid inline datum');
	}
}

/**
 * A fresh copy holding only the fields the signature covers, every key in its
 * one canonical spelling. The shared serializer lowercases keys, so two keys
 * that differ only in case would sign as one while the wire object kept both.
 */
function canonicalOutput(out: SnapshotTxOut): SnapshotTxOut {
	const value: SnapshotTxOut['value'] = {};
	for (const [key, entry] of Object.entries(out.value)) {
		if (key === 'lovelace') {
			if (typeof entry !== 'string') throw new Error('Invalid lovelace');
			value.lovelace = quantity(entry).toString();
			continue;
		}
		if (!/^[0-9a-f]{56}$/.test(key) || typeof entry !== 'object') throw new Error(`Invalid policy "${key}"`);
		const assets: Record<string, string> = {};
		for (const [name, amount] of Object.entries(entry)) {
			if (!/^(?:[0-9a-f]{2}){0,32}$/.test(name)) throw new Error(`Invalid asset name "${name}"`);
			assets[name] = quantity(amount).toString();
		}
		value[key] = assets;
	}
	return {
		address: out.address,
		value,
		datumhash: hexField(out.datumhash, /^[0-9a-f]{64}$/, 'datum hash'),
		inlineDatumRaw: canonicalDatum(hexField(out.inlineDatumRaw, /^(?:[0-9a-f]{2})+$/, 'inline datum')),
	};
}

function canonicalUtxo(utxo: SnapshotUTxO): SnapshotUTxO {
	return Object.fromEntries(
		Object.entries(utxo).map(([ref, out]) => {
			parseTxIn(ref);
			return [ref, canonicalOutput(out)];
		}),
	);
}

/** Expects a canonical output (see `canonicalOutput`). */
function frameOutput(out: SnapshotTxOut): SnapshotOutput {
	const value: HydraValue = {};
	for (const [key, entry] of Object.entries(out.value)) {
		value[key] =
			typeof entry === 'string'
				? BigInt(entry)
				: Object.fromEntries(Object.entries(entry).map(([name, amount]) => [name, BigInt(amount)]));
	}
	return {
		address: out.address,
		value,
		referenceScript: null,
		datumhash: out.datumhash ?? null,
		inlineDatumhash: null,
		inlineDatum: null,
		inlineDatumRaw: out.inlineDatumRaw ?? null,
		datum: null,
	};
}

function frameUtxo(utxo: SnapshotUTxO): SnapshotUtxo {
	return Object.fromEntries(Object.entries(canonicalUtxo(utxo)).map(([ref, out]) => [ref, frameOutput(out)]));
}

/**
 * The snapshot frame the signatures cover. `utxo` stays empty: the signable
 * bytes read it only to cap the output count, and the witness covers it.
 */
function signedFrame(proof: HydraSnapshotProof): HydraSnapshotVerificationFrame {
	return {
		headId: proof.headId,
		signatures: { multiSignature: proof.signatures },
		snapshot: {
			headId: proof.headId,
			version: proof.version,
			number: proof.number,
			accumulator: proof.accumulator,
			confirmed: [],
			utxo: {},
			utxoToCommit: proof.utxoToCommit == null ? null : frameUtxo(proof.utxoToCommit),
			utxoToDecommit: proof.utxoToDecommit == null ? null : frameUtxo(proof.utxoToDecommit),
			depositTxId: proof.depositTxId,
		},
	};
}

/**
 * Check a snapshot proof and return the guarded wallet's output.
 *
 * `partyKeys` must come from somewhere the sender does not control: the
 * `parties` field of the head's state datum on L1, for a head the co-signer
 * already trusts. `stateTokenUnit` (policy id + asset name) is the wallet's own
 * state token, from the co-signer's wallet records. The output may sit in
 * `utxo` or `utxoToCommit` (a deposit stays in the commit set until the next
 * in-head transaction), never in `utxoToDecommit`. Order: the cheap Ed25519
 * signatures first, then two pairings. Throws when anything does not hold.
 */
export function verifyHydraSnapshotProof(params: {
	proof: HydraSnapshotProof;
	headId: string;
	partyKeys: string[];
	stateTokenUnit: string;
}): SnapshotTxOut {
	const { proof, headId, partyKeys, stateTokenUnit } = params;
	// Policy id (28 bytes) and a non-empty asset name (up to 32 bytes).
	if (!/^[0-9a-f]{56}(?:[0-9a-f]{2}){1,32}$/.test(stateTokenUnit)) throw new Error('Invalid state token unit');
	if (proof.headId.toLowerCase() !== headId.toLowerCase()) throw new Error('The snapshot is for another head');
	verifyHydraSnapshotSignatures(signedFrame(proof), partyKeys);
	// Read only canonical copies: they are exactly what was signed.
	const output = canonicalOutput(proof.walletOutput);
	if (!holdsToken(output, stateTokenUnit)) throw new Error('The wallet output does not hold the wallet state token');
	if (Object.values(canonicalUtxo(proof.utxoToDecommit ?? {})).some((out) => holdsToken(out, stateTokenUnit))) {
		throw new Error('The wallet is on its way out of the head');
	}
	verifyHydraMembership({
		accumulator: proof.accumulator,
		commitment: proof.commitment,
		witness: proof.witness,
		serializedOutput: serializeHydraSnapshotOutput(frameOutput(output)),
	});
	return output;
}

function holdsToken(output: SnapshotTxOut, unit: string): boolean {
	const assets = output.value[unit.slice(0, 56)];
	return typeof assets === 'object' && assets[unit.slice(56)] === '1';
}

/** The proof's own form of one output, for a builder that serializes it the way the verifier does. */
export function serializeSnapshotTxOut(output: SnapshotTxOut): string {
	return serializeHydraSnapshotOutput(frameOutput(canonicalOutput(output)));
}
