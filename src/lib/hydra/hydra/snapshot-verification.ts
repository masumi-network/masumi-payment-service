import {
	Address,
	BaseAddress,
	CredKind,
	EnterpriseAddress,
	FixedTransaction,
	NativeScript,
	PlutusScript,
	PointerAddress,
	type Credential,
	type TransactionOutput,
} from '@emurgo/cardano-serialization-lib-nodejs';
import { blake2b } from 'ethereum-cryptography/blake2b.js';
import { Constr, Data, type Data as LucidData } from 'lucid-cardano';
import { createHash, createPublicKey, verify as verifyEd25519Signature } from 'node:crypto';

import { HydraProtocolError } from './errors';
import { MAX_HYDRA_SNAPSHOT_OUTPUTS } from './schemas';
import { computeHydraAccumulatorHash } from './snapshot-accumulator';

// Re-exported so the accumulator move stays invisible to importers: this module
// is the public face of snapshot verification, and callers should not have to
// know which half of it computes the commitment.
export { computeHydraAccumulatorHash } from './snapshot-accumulator';
import {
	HydraScriptLanguage,
	type HydraQuantity,
	type HydraReferenceScript,
	type HydraTransaction,
	type HydraValue,
} from './types';
import { hydraVerificationKeyRawHex } from './keys';
export {
	deriveHydraVerificationKeyCborHex,
	hydraVerificationKeyRawHex,
	normalizeHydraSigningKeyCborHex,
	normalizeHydraVerificationKeyCborHex,
} from './keys';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

type SnapshotOutput = {
	address: string;
	value: HydraValue;
	referenceScript: HydraReferenceScript | null;
	datumhash?: string | null;
	inlineDatumhash?: string | null;
	inlineDatum: unknown;
	inlineDatumRaw: string | null;
	datum: string | null;
};

type SnapshotUtxo = Record<string, SnapshotOutput>;

export type HydraSnapshotVerificationFrame = {
	headId: string;
	signatures: { multiSignature: string[] };
	snapshot: {
		headId: string;
		version: number;
		number: number;
		accumulator: string;
		confirmed: HydraTransaction[];
		utxo: SnapshotUtxo;
		utxoToCommit: SnapshotUtxo | null;
		utxoToDecommit: SnapshotUtxo | null;
	};
};

export type VerifiedHydraSnapshot = {
	headId: string;
	number: number;
	version: number;
	/** Canonical Plutus `TxOut` bytes, keyed by `tx-id#index`. */
	outputs: Map<string, string>;
	/** The only UTxO state committed by Hydra 2.3's accumulator (utxo ∪ commit ∪ decommit). */
	outputMultiset: Map<string, number>;
	/**
	 * This snapshot's PENDING incremental-commit deposits (`utxoToCommit`), keyed
	 * by reference exactly like `outputs`. Signature-authenticated (part of the
	 * accumulator) and L1-backed; the transition check treats a newly declared
	 * one as a legitimate injection and one that leaves without being absorbed as
	 * a legitimate removal, so a topped-up head still replays. Empty when no
	 * commit is pending.
	 *
	 * Keyed by reference rather than by value because every allowance derived
	 * from it has to name the exact output that moved. A value-keyed allowance
	 * cannot tell an absorbed deposit from a recovered one, nor one deposit
	 * re-declared across consecutive snapshots from two separate deposits — and
	 * these values collide routinely: a withdrawal and a top-up of the same size
	 * to the same wallet serialize to the same bytes.
	 */
	committedOutputs: Map<string, string>;
	/** This snapshot's pending decommits (`utxoToDecommit`), keyed like `outputs`. */
	decommitOutputs: Map<string, string>;
};

export type VerifiedHydraFanoutReference = {
	txHash: string;
	outputIndex: number;
	snapshotNumber: number;
	serializedOutput: string;
};

function parseFanoutReference(
	reference: string,
	snapshotNumber: number,
	serializedOutput: string,
): VerifiedHydraFanoutReference | null {
	const normalizedReference = reference.toLowerCase();
	const separator = normalizedReference.indexOf('#');
	if (separator <= 0 || normalizedReference.indexOf('#', separator + 1) !== -1) return null;
	const txHash = normalizedReference.slice(0, separator);
	const outputIndexText = normalizedReference.slice(separator + 1);
	if (!/^(?:0|[1-9][0-9]*)$/.test(outputIndexText)) return null;
	const outputIndex = Number(outputIndexText);
	if (
		!/^[0-9a-f]{64}$/.test(txHash) ||
		!Number.isSafeInteger(outputIndex) ||
		outputIndex < 0 ||
		outputIndex > 0xffffffff
	) {
		return null;
	}
	return { txHash, outputIndex, snapshotNumber, serializedOutput };
}

function credentialToPlutusData(credential: Credential): Constr<LucidData> {
	if (credential.kind() === CredKind.Key) {
		const keyHash = credential.to_keyhash();
		if (!keyHash) throw new HydraProtocolError('Hydra output contained an invalid key credential');
		return new Constr(0, [keyHash.to_hex()]);
	}
	const scriptHash = credential.to_scripthash();
	if (!scriptHash) throw new HydraProtocolError('Hydra output contained an invalid script credential');
	return new Constr(1, [scriptHash.to_hex()]);
}

function addressToPlutusData(addressString: string): Constr<LucidData> {
	let address: Address;
	try {
		address = /^(?:[0-9a-fA-F]{2})+$/.test(addressString)
			? Address.from_bytes(Buffer.from(addressString, 'hex'))
			: Address.from_bech32(addressString);
	} catch (error) {
		throw new HydraProtocolError('Hydra snapshot contained an invalid Cardano address', { cause: error });
	}

	const baseAddress = BaseAddress.from_address(address);
	if (baseAddress) {
		return new Constr(0, [
			credentialToPlutusData(baseAddress.payment_cred()),
			new Constr(0, [new Constr(0, [credentialToPlutusData(baseAddress.stake_cred())])]),
		]);
	}

	const enterpriseAddress = EnterpriseAddress.from_address(address);
	if (enterpriseAddress) {
		return new Constr(0, [credentialToPlutusData(enterpriseAddress.payment_cred()), new Constr(1, [])]);
	}

	const pointerAddress = PointerAddress.from_address(address);
	if (pointerAddress) {
		const pointer = pointerAddress.stake_pointer();
		return new Constr(0, [
			credentialToPlutusData(pointerAddress.payment_cred()),
			new Constr(0, [
				new Constr(1, [
					BigInt(pointer.slot_bignum().to_str()),
					BigInt(pointer.tx_index_bignum().to_str()),
					BigInt(pointer.cert_index_bignum().to_str()),
				]),
			]),
		]);
	}

	throw new HydraProtocolError('Hydra snapshot contained an unsupported Byron or reward output address');
}

function valueToPlutusData(value: Map<string, Map<string, bigint>>): Map<LucidData, LucidData> {
	const outer = new Map<LucidData, LucidData>();
	for (const [policyId, assets] of value) {
		const inner = new Map<LucidData, LucidData>();
		for (const [assetName, quantity] of assets) {
			if (quantity < 0n) throw new HydraProtocolError('Hydra output contained a negative asset quantity');
			inner.set(assetName, quantity);
		}
		outer.set(policyId, inner);
	}
	return outer;
}

function hydraValueToBigIntMap(value: HydraValue): Map<string, Map<string, bigint>> {
	const result = new Map<string, Map<string, bigint>>();
	const lovelace = value.lovelace;
	if (lovelace == null) {
		throw new HydraProtocolError('Hydra output omitted or contained an invalid lovelace quantity');
	}
	const lovelaceQuantity = toExactNonNegativeQuantity(lovelace);
	// Cardano's Plutus Value representation places the ADA currency symbol
	// first, followed by ordered policy ids. Never inherit JSON property order:
	// Zod/JSON producers may reconstruct an otherwise identical value object.
	result.set('', new Map([['', lovelaceQuantity]]));
	const policies = Object.entries(value)
		.filter(([policyId]) => policyId !== 'lovelace')
		.sort(([left], [right]) => Buffer.compare(Buffer.from(left, 'hex'), Buffer.from(right, 'hex')));
	for (const [policyId, policyValue] of policies) {
		if (policyValue == null) continue;
		if (typeof policyValue === 'number' || typeof policyValue === 'bigint') {
			throw new HydraProtocolError('Hydra output contained a numeric non-lovelace policy value');
		}
		if (!/^[0-9a-fA-F]{56}$/.test(policyId)) {
			throw new HydraProtocolError('Hydra output contained an invalid policy identifier');
		}
		const assets = new Map<string, bigint>();
		const orderedAssets = Object.entries(policyValue).sort(([left], [right]) =>
			Buffer.compare(Buffer.from(left, 'hex'), Buffer.from(right, 'hex')),
		);
		for (const [assetName, quantity] of orderedAssets) {
			if (!/^(?:[0-9a-fA-F]{2}){0,32}$/.test(assetName)) {
				throw new HydraProtocolError('Hydra output contained an invalid native asset');
			}
			assets.set(assetName.toLowerCase(), toExactNonNegativeQuantity(quantity));
		}
		result.set(policyId.toLowerCase(), assets);
	}
	return result;
}

function toExactNonNegativeQuantity(quantity: HydraQuantity): bigint {
	if (typeof quantity === 'number' && !Number.isSafeInteger(quantity)) {
		throw new HydraProtocolError('Hydra output contained an inexact asset quantity');
	}
	const integer = BigInt(quantity);
	if (integer < 0n) throw new HydraProtocolError('Hydra output contained a negative asset quantity');
	return integer;
}

function transactionValueToBigIntMap(output: TransactionOutput): Map<string, Map<string, bigint>> {
	const value = output.amount();
	const result = new Map<string, Map<string, bigint>>([['', new Map([['', BigInt(value.coin().to_str())]])]]);
	const multiAsset = value.multiasset();
	if (!multiAsset) return result;
	const policies = multiAsset.keys();
	for (let policyIndex = 0; policyIndex < policies.len(); policyIndex++) {
		const policy = policies.get(policyIndex);
		const policyAssets = multiAsset.get(policy);
		if (!policyAssets) throw new HydraProtocolError('Hydra transaction output contained an invalid multi-asset value');
		const assets = new Map<string, bigint>();
		const assetNames = policyAssets.keys();
		for (let assetIndex = 0; assetIndex < assetNames.len(); assetIndex++) {
			const assetName = assetNames.get(assetIndex);
			const quantity = policyAssets.get(assetName);
			if (!quantity) throw new HydraProtocolError('Hydra transaction output omitted an asset quantity');
			assets.set(Buffer.from(assetName.name()).toString('hex'), BigInt(quantity.to_str()));
		}
		result.set(policy.to_hex(), assets);
	}
	return result;
}

function referenceScriptHash(referenceScript: HydraReferenceScript): string {
	const scriptBytes = Buffer.from(referenceScript.script.cborHex, 'hex');
	try {
		switch (referenceScript.script.type) {
			case HydraScriptLanguage.SimpleScript:
				return NativeScript.from_bytes(scriptBytes).hash().to_hex();
			case HydraScriptLanguage.PlutusScriptV1:
				return PlutusScript.from_bytes(scriptBytes).hash().to_hex();
			case HydraScriptLanguage.PlutusScriptV2:
				return PlutusScript.from_bytes_v2(scriptBytes).hash().to_hex();
			case HydraScriptLanguage.PlutusScriptV3:
				return PlutusScript.from_bytes_v3(scriptBytes).hash().to_hex();
		}
	} catch (error) {
		throw new HydraProtocolError('Hydra output contained an invalid reference script', { cause: error });
	}
}

function datumToPlutusData(output: SnapshotOutput): Constr<LucidData> {
	if (output.inlineDatumRaw != null) {
		if (output.datumhash != null) {
			throw new HydraProtocolError('Hydra output contained both a datum hash and an inline datum');
		}
		let inlineDatum: LucidData;
		try {
			inlineDatum = Data.from(output.inlineDatumRaw);
		} catch (error) {
			throw new HydraProtocolError('Hydra output contained invalid inline datum CBOR', { cause: error });
		}
		const canonicalDatum = Data.to(inlineDatum);
		if (
			output.inlineDatumhash != null &&
			Buffer.from(blake2b(Buffer.from(canonicalDatum, 'hex'), 32)).toString('hex') !==
				output.inlineDatumhash.toLowerCase()
		) {
			throw new HydraProtocolError('Hydra inline datum hash did not match its canonical datum bytes');
		}
		return new Constr(2, [inlineDatum]);
	}
	if (output.inlineDatum != null || output.inlineDatumhash != null) {
		throw new HydraProtocolError('Hydra output exposed inline datum metadata without canonical inlineDatumRaw bytes');
	}
	if (output.datumhash != null) return new Constr(1, [output.datumhash.toLowerCase()]);
	return new Constr(0, []);
}

export function serializeHydraSnapshotOutput(output: SnapshotOutput): string {
	const scriptHash =
		output.referenceScript == null
			? new Constr<LucidData>(1, [])
			: new Constr(0, [referenceScriptHash(output.referenceScript)]);
	return Data.to(
		new Constr(0, [
			addressToPlutusData(output.address),
			valueToPlutusData(hydraValueToBigIntMap(output.value)),
			datumToPlutusData(output),
			scriptHash,
		]),
	);
}

export function serializeCardanoTransactionOutput(output: TransactionOutput): string {
	const datumHash = output.data_hash();
	const inlineDatum = output.plutus_data();
	if (datumHash && inlineDatum) {
		throw new HydraProtocolError('Hydra transaction output contained two datum representations');
	}
	const datum = inlineDatum
		? new Constr<LucidData>(2, [Data.from(Buffer.from(inlineDatum.to_bytes()).toString('hex'))])
		: datumHash
			? new Constr<LucidData>(1, [datumHash.to_hex()])
			: new Constr<LucidData>(0, []);
	const scriptRef = output.script_ref();
	let scriptHash: Constr<LucidData>;
	if (!scriptRef) {
		scriptHash = new Constr(1, []);
	} else if (scriptRef.is_native_script()) {
		const nativeScript = scriptRef.native_script();
		if (!nativeScript) throw new HydraProtocolError('Hydra transaction output had an invalid native script reference');
		scriptHash = new Constr(0, [nativeScript.hash().to_hex()]);
	} else {
		const plutusScript = scriptRef.plutus_script();
		if (!plutusScript) throw new HydraProtocolError('Hydra transaction output had an invalid Plutus script reference');
		scriptHash = new Constr(0, [plutusScript.hash().to_hex()]);
	}
	return Data.to(
		new Constr(0, [
			addressToPlutusData(output.address().to_bech32()),
			valueToPlutusData(transactionValueToBigIntMap(output)),
			datum,
			scriptHash,
		]),
	);
}

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
	return Buffer.concat([
		cborBytes(Buffer.from(snapshot.headId, 'hex')),
		cborUnsigned(snapshot.version),
		cborUnsigned(snapshot.number),
		cborBytes(Buffer.from(snapshot.accumulator, 'hex')),
		cborBytes(hashPendingUtxo(snapshot.utxoToDecommit)),
		cborBytes(hashPendingUtxo(snapshot.utxoToCommit)),
	]);
}

function canonicalSnapshotOutputs(snapshot: HydraSnapshotVerificationFrame['snapshot']): Map<string, string> {
	const result = new Map<string, string>();
	for (const utxo of [snapshot.utxo, snapshot.utxoToCommit ?? {}, snapshot.utxoToDecommit ?? {}]) {
		for (const [reference, output] of Object.entries(utxo)) {
			const canonicalReference = reference.toLowerCase();
			if (result.has(canonicalReference)) {
				throw new HydraProtocolError('Hydra snapshot repeated one output reference across state partitions');
			}
			result.set(canonicalReference, serializeHydraSnapshotOutput(output));
		}
	}
	if (result.size > MAX_HYDRA_SNAPSHOT_OUTPUTS) {
		throw new HydraProtocolError(`Hydra snapshot exceeded the ${MAX_HYDRA_SNAPSHOT_OUTPUTS}-output KZG limit`);
	}
	return result;
}

function outputMultiset(outputs: Iterable<string>): Map<string, number> {
	const result = new Map<string, number>();
	for (const output of outputs) result.set(output, (result.get(output) ?? 0) + 1);
	return result;
}

function numberMapsEqual(left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>): boolean {
	return left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);
}

/**
 * What the fanout may legitimately pay out for this signed state.
 *
 * The canonical set the accumulator is computed over is all three partitions,
 * because that is what the signature commits to. The fanout is not: a deposit
 * still sitting in `utxoToCommit` has not entered the head — its funds are at
 * the L1 deposit script, where the depositor recovers them — and distributing
 * it as well would be a double spend. A pending DECOMMIT is the mirror image:
 * the decrement has not landed, so those funds are still in the head's L1 UTxO
 * and the fanout does pay them out.
 *
 * Both forms are accepted rather than only the second, because the snapshot
 * this is checked against is the one the database recorded, and an increment
 * that landed on L1 just before the close moves the same outputs from
 * `utxoToCommit` into `utxo` — which our copy may not have seen yet. Requiring
 * the full set was the bug: a head closed with any deposit in flight resolved
 * no fanout reference at all, so `prepareFinalHandoff` returned null on every
 * poll — deterministically, from replayed history — and every payment in that
 * head stayed pinned to in-head UTxOs that no longer exist, on a head already
 * Final with no protocol action left to unstick it.
 */
function expectedFanoutMultisets(snapshot: VerifiedHydraSnapshot): Array<ReadonlyMap<string, number>> {
	if (snapshot.committedOutputs.size === 0) return [snapshot.outputMultiset];
	const withoutCommitted = new Map(snapshot.outputMultiset);
	for (const serializedOutput of snapshot.committedOutputs.values()) {
		const remaining = (withoutCommitted.get(serializedOutput) ?? 0) - 1;
		if (remaining > 0) withoutCommitted.set(serializedOutput, remaining);
		else withoutCommitted.delete(serializedOutput);
	}
	return [snapshot.outputMultiset, withoutCommitted];
}

/**
 * Bind the complete signature-verified final state to hydra-node's complete
 * chain-observed fanout map. Unlike the single-output resolver below, this can
 * retain duplicate values because every actual L1 reference is independently
 * checked and the complete value multiset is authenticated.
 */
export function resolveVerifiedHydraFanoutReferences(
	snapshot: VerifiedHydraSnapshot,
	fanoutOutputs: ReadonlyMap<string, string>,
): VerifiedHydraFanoutReference[] | null {
	const observed = outputMultiset(fanoutOutputs.values());
	if (!expectedFanoutMultisets(snapshot).some((expected) => numberMapsEqual(expected, observed))) return null;
	const references: VerifiedHydraFanoutReference[] = [];
	for (const [reference, serializedOutput] of fanoutOutputs) {
		const parsed = parseFanoutReference(reference, snapshot.number, serializedOutput);
		if (!parsed) return null;
		references.push(parsed);
	}
	if (references.length === 0) return null;
	// A head too large to empty in one transaction is fanned out over several, so
	// references legitimately span transactions and an output index only has to
	// be unique within its own. Requiring one transaction here rejected every
	// partial fanout outright; requiring globally unique indexes would have
	// rejected them anyway, since each step numbers its outputs from zero.
	// What still has to hold — that the steps form one chain ending in the head's
	// token burn — is proved on chain by the fanout verifier, and that every
	// signed output is accounted for exactly once is the multiset check above.
	if (new Set(references.map(({ txHash, outputIndex }) => `${txHash}#${outputIndex}`)).size !== references.length) {
		return null;
	}
	return references.sort(
		(left, right) => left.txHash.localeCompare(right.txHash) || left.outputIndex - right.outputIndex,
	);
}

/**
 * Map one independently reconstructed in-head TxOut to its exact L1 fanout
 * reference.
 *
 * Hydra snapshot signatures authenticate a multiset of serialized TxOuts, not
 * either reference map. The caller must therefore derive `serializedOutput`
 * from the retained producer transaction CBOR at its exact txHash#index; using
 * `snapshot.outputs.get(reference)` here would let an endpoint permute unsigned
 * references while preserving every signature and accumulator. Identical
 * TxOuts remain intentionally ambiguous.
 */
export function resolveVerifiedHydraFanoutReference(
	snapshot: VerifiedHydraSnapshot,
	fanoutOutputs: ReadonlyMap<string, string>,
	serializedOutput: string,
): VerifiedHydraFanoutReference | null {
	const verifiedFanoutReferences = resolveVerifiedHydraFanoutReferences(snapshot, fanoutOutputs);
	if (!verifiedFanoutReferences) return null;
	const fanoutMultiset = outputMultiset(fanoutOutputs.values());

	if (snapshot.outputMultiset.get(serializedOutput) !== 1 || fanoutMultiset.get(serializedOutput) !== 1) {
		return null;
	}
	const matchingReferences = verifiedFanoutReferences.filter(
		(reference) => reference.serializedOutput === serializedOutput,
	);
	return matchingReferences.length === 1 ? matchingReferences[0] : null;
}

export function verifyHydraSnapshot(
	frame: HydraSnapshotVerificationFrame,
	orderedVerificationKeys: readonly string[],
): VerifiedHydraSnapshot {
	if (frame.headId !== frame.snapshot.headId) {
		throw new HydraProtocolError('SnapshotConfirmed top-level and signed snapshot head identifiers differed');
	}
	const rawVerificationKeys = orderedVerificationKeys.map(hydraVerificationKeyRawHex);
	if (
		rawVerificationKeys.length === 0 ||
		new Set(rawVerificationKeys).size !== rawVerificationKeys.length ||
		frame.signatures.multiSignature.length !== rawVerificationKeys.length
	) {
		throw new HydraProtocolError('SnapshotConfirmed signature count did not match the configured unique party set');
	}
	const signableBytes = hydraSnapshotSignableBytes(frame);
	for (let index = 0; index < rawVerificationKeys.length; index++) {
		const publicKey = createPublicKey({
			key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawVerificationKeys[index], 'hex')]),
			format: 'der',
			type: 'spki',
		});
		if (
			!verifyEd25519Signature(
				null,
				signableBytes,
				publicKey,
				Buffer.from(frame.signatures.multiSignature[index], 'hex'),
			)
		) {
			throw new HydraProtocolError(`SnapshotConfirmed signature ${index} was invalid for the bound party order`);
		}
	}
	// KZG recomputation is intentionally after the cheap Ed25519 gate. An
	// unauthenticated websocket peer must not be able to force polynomial/MSM
	// work with arbitrary maximum-size states.
	const outputs = canonicalSnapshotOutputs(frame.snapshot);
	const computedAccumulator = computeHydraAccumulatorHash(outputs.values());
	if (computedAccumulator !== frame.snapshot.accumulator.toLowerCase()) {
		throw new HydraProtocolError('SnapshotConfirmed accumulator did not match its full canonical UTxO state');
	}
	return {
		headId: frame.snapshot.headId,
		number: frame.snapshot.number,
		version: frame.snapshot.version,
		outputs,
		outputMultiset: outputMultiset(outputs.values()),
		committedOutputs: partitionOutputReferences(frame.snapshot.utxoToCommit),
		decommitOutputs: partitionOutputReferences(frame.snapshot.utxoToDecommit),
	};
}

/** Reference-keyed outputs of one signed snapshot partition (utxoToCommit/utxoToDecommit). */
function partitionOutputReferences(partition: SnapshotUtxo | null | undefined): Map<string, string> {
	const result = new Map<string, string>();
	if (!partition) return result;
	for (const [reference, output] of Object.entries(partition)) {
		result.set(reference.toLowerCase(), serializeHydraSnapshotOutput(output));
	}
	return result;
}

/**
 * Check that locally-attested transaction bodies are consistent with the
 * multiset delta between consecutive signed states. Hydra 2.3 commits only
 * serialized TxOut values: it does NOT commit TxIn→TxOut references, witness
 * bytes, or the `confirmed` list. Consequently this function deliberately
 * never uses the endpoint-supplied snapshot reference map as cryptographic
 * evidence. Transaction metadata still requires an explicitly trusted local
 * Hydra endpoint plus the manager's action-specific actor/body validation.
 *
 * The first signed snapshot is intentionally only an anchor: without a signed
 * predecessor its `confirmed` list is not even state-delta evidence.
 *
 * Before changing what this accepts, and before upgrading hydra-node, read
 * docs/adr/0012-hydra-snapshot-verification-and-upgrades.md: it carries the
 * upgrade checklist and the record of the two legitimate protocol behaviours
 * this check has already been wrong about.
 */
export function doesHydraTransactionTransitionReachSnapshot(
	previous: VerifiedHydraSnapshot,
	current: VerifiedHydraSnapshot,
	transactions: readonly HydraTransaction[],
): boolean {
	if (previous.headId !== current.headId || current.number !== previous.number + 1) return false;
	try {
		const createdOutputs = new Map<string, string>();
		const spentReferences = new Set<string>();
		let externalInputCount = 0;
		for (const claimedTransaction of transactions) {
			if (claimedTransaction.txId == null) return false;
			const transaction = FixedTransaction.from_bytes(Buffer.from(claimedTransaction.cborHex, 'hex'));
			if (!transaction.is_valid()) return false;
			const transactionId = transaction.transaction_hash().to_hex().toLowerCase();
			if (transactionId !== claimedTransaction.txId.toLowerCase()) return false;
			const body = transaction.body();
			const inputs = body.inputs();
			for (let inputIndex = 0; inputIndex < inputs.len(); inputIndex++) {
				const input = inputs.get(inputIndex);
				const reference = `${input.transaction_id().to_hex().toLowerCase()}#${input.index()}`;
				if (spentReferences.has(reference)) return false;
				spentReferences.add(reference);
				if (createdOutputs.has(reference)) createdOutputs.delete(reference);
				else externalInputCount += 1;
			}

			const outputs = body.outputs();
			// A no-output body has no value contribution to compare with the signed
			// multiset and therefore cannot support endpoint metadata attestation.
			if (outputs.len() === 0) return false;
			for (let outputIndex = 0; outputIndex < outputs.len(); outputIndex++) {
				const reference = `${transactionId}#${outputIndex}`;
				if (createdOutputs.has(reference)) return false;
				createdOutputs.set(reference, serializeCardanoTransactionOutput(outputs.get(outputIndex)));
			}
		}

		const survivingCreated = outputMultiset(createdOutputs.values());
		// Incremental commits inject value into the head and decommits remove it,
		// both OUTSIDE the confirmed-tx list. Each is authenticated by the
		// multi-signature over the accumulator (and, for commits, an on-chain L1
		// deposit), so a snapshot's pending-commit outputs are legitimate injections
		// and pending-decommit outputs are legitimate removals. Value still cannot
		// appear or vanish through the (unauthenticated) confirmed-tx list — that
		// path stays bound by strict created/consumed conservation and the
		// externalInputCount tie below.
		//
		// Every allowance below is derived by REFERENCE and only then counted by
		// value: a pending entry earns slack only if that exact output actually
		// arrived or actually left. Deriving them from the value multisets instead
		// was wrong in three separate directions at once, all of them reachable on
		// an ordinary head, because a withdrawal and a top-up of the same size to
		// the same wallet serialize to identical bytes:
		//
		//   - a deposit still pending in BOTH snapshots was granted injection slack
		//     on every transition it survived, even though it is already counted in
		//     `previous`, letting an unexplained output of that value materialise;
		//   - a deposit that was ABSORBED — the normal ending — still counted as
		//     recoverable, letting an in-head output of that value disappear with no
		//     transaction to account for it;
		//   - an ordinary spend of any same-valued in-head UTxO cancelled a real
		//     deposit's recovery allowance, rejecting a legitimate transition. That
		//     one is the worst of the three: history replays from the beginning on
		//     every reconnect, so a rejected frame is rejected forever — no verified
		//     session, and every L2 escrow operation on that head fails closed.
		//
		// A deposit is an injection only on the snapshot that first declares it.
		const injectionAllowance = new Map<string, number>();
		for (const [reference, value] of current.committedOutputs) {
			if (previous.outputs.has(reference)) continue;
			injectionAllowance.set(value, (injectionAllowance.get(value) ?? 0) + 1);
		}
		// Two authenticated ways for value to leave without a transaction.
		//
		// A pending decommit is the obvious one. The second is a deposit that was
		// recovered instead of absorbed: it sits in a signed snapshot's
		// utxoToCommit, and if the increment never lands the depositor takes it back
		// on L1 with a recoverTx, so the next snapshot drops it having never reached
		// `utxo`. Both are covered by the multi-signature over the accumulator, and
		// neither moves value anywhere the ledger does not already enforce: a
		// recovered deposit returns to whoever deposited it.
		//
		// An entry that is still present in `current` has not left — a deposit that
		// was absorbed keeps its reference on its way into `utxo` — and one that a
		// transaction spent is already accounted for by that transaction's input.
		// Neither earns an allowance; counting either would let value vanish twice.
		//
		// A removal identified this way is CERTAIN, not an upper bound: the entry
		// was pending, it is not in `current`, and no transaction spent it, so it
		// left. Treating it as optional slack let an unexplained output of the same
		// value take its place — the settled decommit paid for the arrival and the
		// transition was accepted with value appearing from nowhere.
		const removalCount = new Map<string, number>();
		for (const pendingOutputs of [previous.decommitOutputs, previous.committedOutputs]) {
			for (const [reference, value] of pendingOutputs) {
				if (current.outputs.has(reference) || spentReferences.has(reference)) continue;
				removalCount.set(value, (removalCount.get(value) ?? 0) + 1);
			}
		}
		const allOutputs = new Set([
			...previous.outputMultiset.keys(),
			...current.outputMultiset.keys(),
			...survivingCreated.keys(),
			...injectionAllowance.keys(),
			...removalCount.keys(),
		]);
		// Per serialized value the transition equation is
		//
		//   current = previous + created + injected - consumed - removed
		//
		// with `injected` free in [0, injectionAllowance] and `removed` fixed at
		// `removalCount`. That leaves ONE free variable per value, so `consumed` is
		// not a number to compute but an interval to intersect: every extra deposit
		// admitted is an extra previous output the confirmed list may have spent.
		//
		// Choosing a point on that interval — the minimum injection, which is also
		// the minimum consumption — and then demanding it equal `externalInputCount`
		// exactly was wrong whenever one value was both injected and consumed in the
		// same transition. That is an ordinary shape, not a corner: a top-up is an
		// exact-amount carve committed whole to the participant's own wallet, so a
		// second top-up of the same size is byte-identical to what the first left in
		// the head, and any L2 transaction spending the first one collides with it.
		// The walk under-counted consumption, rejected the frame, and history
		// replays from the beginning on every reconnect — so the head lost its
		// verified session for good and every L2 escrow operation on it failed
		// closed.
		//
		// Writing the free variable as d = injected - removed, the bounds are the
		// allowance itself plus `consumed >= 0` and `consumed <= previous` (the
		// confirmed list cannot spend a deposit that has not landed yet).
		let minimumConsumed = 0;
		let maximumConsumed = 0;
		for (const output of allOutputs) {
			const previousCount = previous.outputMultiset.get(output) ?? 0;
			const createdCount = survivingCreated.get(output) ?? 0;
			const currentCount = current.outputMultiset.get(output) ?? 0;
			const removed = removalCount.get(output) ?? 0;
			const injectable = injectionAllowance.get(output) ?? 0;
			const lowestDelta = Math.max(-removed, currentCount - previousCount - createdCount);
			const highestDelta = Math.min(injectable - removed, currentCount - createdCount);
			// No injection count can satisfy the equation for this value at all: the
			// surplus exceeds what the declared deposits can supply, or the shortfall
			// exceeds what the previous state held.
			if (lowestDelta > highestDelta) return false;
			minimumConsumed += previousCount + createdCount - currentCount + lowestDelta;
			maximumConsumed += previousCount + createdCount - currentCount + highestDelta;
		}
		if (!Number.isSafeInteger(minimumConsumed) || !Number.isSafeInteger(maximumConsumed)) return false;
		// Each value's delta moves independently over a contiguous integer range, so
		// every total in between is reachable and the tie is a containment test.
		return externalInputCount >= minimumConsumed && externalInputCount <= maximumConsumed;
	} catch {
		return false;
	}
}
