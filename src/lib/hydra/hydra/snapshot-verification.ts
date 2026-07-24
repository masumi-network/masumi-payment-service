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
import { bls12_381 } from 'ethereum-cryptography/bls.js';
import { blake2b } from 'ethereum-cryptography/blake2b.js';
import { Constr, Data, type Data as LucidData } from 'lucid-cardano';
import { createHash, createPublicKey, verify as verifyEd25519Signature } from 'node:crypto';

import { HydraProtocolError } from './errors';
import { HYDRA_KZG_G1_0 } from './kzg/hydra-kzg-g1-0';
import { HYDRA_KZG_G1_1 } from './kzg/hydra-kzg-g1-1';
import { HYDRA_KZG_G1_2 } from './kzg/hydra-kzg-g1-2';
import { HYDRA_KZG_G1_3 } from './kzg/hydra-kzg-g1-3';
import { HYDRA_KZG_G1_4 } from './kzg/hydra-kzg-g1-4';
import { HYDRA_KZG_G1_5 } from './kzg/hydra-kzg-g1-5';
import { HYDRA_KZG_G1_6 } from './kzg/hydra-kzg-g1-6';
import { HYDRA_KZG_G1_7 } from './kzg/hydra-kzg-g1-7';
import { MAX_HYDRA_SNAPSHOT_OUTPUTS } from './schemas';
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
const BLS_SCALAR_ORDER = bls12_381.fields.Fr.ORDER;
const BLS_SCALAR_GENERATOR = 7n;
const TRUSTED_SETUP_POINT_HEX_LENGTH = 96;
const TRUSTED_SETUP_SHA256 = '08797579f6cfd5788eddc1a215d64dcfabd04acbcaf2953fb2c1afb830f43315';
const TRUSTED_SETUP_G1_HEX =
	HYDRA_KZG_G1_0 +
	HYDRA_KZG_G1_1 +
	HYDRA_KZG_G1_2 +
	HYDRA_KZG_G1_3 +
	HYDRA_KZG_G1_4 +
	HYDRA_KZG_G1_5 +
	HYDRA_KZG_G1_6 +
	HYDRA_KZG_G1_7;

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
	 * Value-multiset of this snapshot's PENDING incremental-commit deposits
	 * (`utxoToCommit`). Signature-authenticated (part of the accumulator) and
	 * L1-backed; the transition check treats these as legitimate injections so a
	 * topped-up head still replays. Empty when no commit is pending.
	 */
	committedMultiset: Map<string, number>;
	/** Value-multiset of this snapshot's pending decommits (`utxoToDecommit`). */
	decommitMultiset: Map<string, number>;
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

function mod(value: bigint): bigint {
	const reduced = value % BLS_SCALAR_ORDER;
	return reduced < 0n ? reduced + BLS_SCALAR_ORDER : reduced;
}

function modPow(base: bigint, exponent: bigint): bigint {
	let result = 1n;
	let factor = mod(base);
	let remaining = exponent;
	while (remaining > 0n) {
		if ((remaining & 1n) === 1n) result = mod(result * factor);
		factor = mod(factor * factor);
		remaining >>= 1n;
	}
	return result;
}

function ntt(values: bigint[], inverse: boolean): void {
	const size = values.length;
	for (let index = 1, reversed = 0; index < size; index++) {
		let bit = size >> 1;
		for (; (reversed & bit) !== 0; bit >>= 1) reversed ^= bit;
		reversed ^= bit;
		if (index < reversed) [values[index], values[reversed]] = [values[reversed], values[index]];
	}
	for (let length = 2; length <= size; length <<= 1) {
		let root = modPow(BLS_SCALAR_GENERATOR, (BLS_SCALAR_ORDER - 1n) / BigInt(length));
		if (inverse) root = modPow(root, BLS_SCALAR_ORDER - 2n);
		for (let offset = 0; offset < size; offset += length) {
			let factor = 1n;
			for (let index = 0; index < length / 2; index++) {
				const even = values[offset + index];
				const odd = mod(values[offset + index + length / 2] * factor);
				values[offset + index] = mod(even + odd);
				values[offset + index + length / 2] = mod(even - odd);
				factor = mod(factor * root);
			}
		}
	}
	if (inverse) {
		const inverseSize = modPow(BigInt(size), BLS_SCALAR_ORDER - 2n);
		for (let index = 0; index < size; index++) values[index] = mod(values[index] * inverseSize);
	}
}

function multiplyPolynomials(left: bigint[], right: bigint[]): bigint[] {
	const resultLength = left.length + right.length - 1;
	if (Math.min(left.length, right.length) <= 32) {
		const result = Array<bigint>(resultLength).fill(0n);
		for (let leftIndex = 0; leftIndex < left.length; leftIndex++) {
			for (let rightIndex = 0; rightIndex < right.length; rightIndex++) {
				result[leftIndex + rightIndex] = mod(result[leftIndex + rightIndex] + left[leftIndex] * right[rightIndex]);
			}
		}
		return result;
	}
	let size = 1;
	while (size < resultLength) size <<= 1;
	const transformedLeft = [...left, ...Array<bigint>(size - left.length).fill(0n)];
	const transformedRight = [...right, ...Array<bigint>(size - right.length).fill(0n)];
	ntt(transformedLeft, false);
	ntt(transformedRight, false);
	for (let index = 0; index < size; index++) {
		transformedLeft[index] = mod(transformedLeft[index] * transformedRight[index]);
	}
	ntt(transformedLeft, true);
	return transformedLeft.slice(0, resultLength);
}

function polynomialFromRoots(roots: bigint[]): bigint[] {
	if (roots.length === 0) return [1n];
	let polynomials = roots.map((root) => [root, 1n]);
	while (polynomials.length > 1) {
		const next: bigint[][] = [];
		for (let index = 0; index < polynomials.length; index += 2) {
			const right = polynomials[index + 1];
			next.push(right ? multiplyPolynomials(polynomials[index], right) : polynomials[index]);
		}
		polynomials = next;
	}
	return polynomials[0];
}

let trustedSetupChecked = false;
const trustedSetupPoints: Array<ReturnType<typeof bls12_381.G1.ProjectivePoint.fromHex>> = [];

function getTrustedSetupPoints(count: number) {
	if (!trustedSetupChecked) {
		const setupBytes = Buffer.from(TRUSTED_SETUP_G1_HEX, 'hex');
		if (
			TRUSTED_SETUP_G1_HEX.length !== 4096 * TRUSTED_SETUP_POINT_HEX_LENGTH ||
			createHash('sha256').update(setupBytes).digest('hex') !== TRUSTED_SETUP_SHA256
		) {
			throw new HydraProtocolError('Bundled Hydra KZG trusted setup failed its integrity check');
		}
		trustedSetupChecked = true;
	}
	while (trustedSetupPoints.length < count) {
		const index = trustedSetupPoints.length;
		const pointHex = TRUSTED_SETUP_G1_HEX.slice(
			index * TRUSTED_SETUP_POINT_HEX_LENGTH,
			(index + 1) * TRUSTED_SETUP_POINT_HEX_LENGTH,
		);
		trustedSetupPoints.push(bls12_381.G1.ProjectivePoint.fromHex(pointHex));
	}
	return trustedSetupPoints.slice(0, count);
}

export function computeHydraAccumulatorHash(serializedOutputs: Iterable<string>): string {
	const outputs = [...serializedOutputs];
	if (outputs.length > MAX_HYDRA_SNAPSHOT_OUTPUTS) {
		throw new HydraProtocolError(`Hydra snapshot exceeded the ${MAX_HYDRA_SNAPSHOT_OUTPUTS}-output KZG limit`);
	}
	const roots = outputs.map((output) => {
		const outputHash = createHash('sha256').update(Buffer.from(output, 'hex')).digest();
		return BigInt(`0x${Buffer.from(blake2b(outputHash, 28)).toString('hex')}`);
	});
	const coefficients = polynomialFromRoots(roots);
	const points = getTrustedSetupPoints(coefficients.length);
	const nonzeroPoints = [];
	const nonzeroScalars = [];
	for (let index = 0; index < coefficients.length; index++) {
		if (coefficients[index] === 0n) continue;
		nonzeroPoints.push(points[index]);
		nonzeroScalars.push(coefficients[index]);
	}
	const commitment = bls12_381.G1.ProjectivePoint.msm(nonzeroPoints, nonzeroScalars);
	return Buffer.from(blake2b(commitment.toRawBytes(true), 32)).toString('hex');
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
 * Bind the complete signature-verified final state to hydra-node's complete
 * chain-observed fanout map. Unlike the single-output resolver below, this can
 * retain duplicate values because every actual L1 reference is independently
 * checked and the complete value multiset is authenticated.
 */
export function resolveVerifiedHydraFanoutReferences(
	snapshot: VerifiedHydraSnapshot,
	fanoutOutputs: ReadonlyMap<string, string>,
): VerifiedHydraFanoutReference[] | null {
	if (!numberMapsEqual(snapshot.outputMultiset, outputMultiset(fanoutOutputs.values()))) return null;
	const references: VerifiedHydraFanoutReference[] = [];
	for (const [reference, serializedOutput] of fanoutOutputs) {
		const parsed = parseFanoutReference(reference, snapshot.number, serializedOutput);
		if (!parsed) return null;
		references.push(parsed);
	}
	if (references.length === 0) return null;
	if (new Set(references.map(({ txHash }) => txHash)).size !== 1) return null;
	if (new Set(references.map(({ outputIndex }) => outputIndex)).size !== references.length) return null;
	return references.sort((left, right) => left.outputIndex - right.outputIndex);
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
		committedMultiset: partitionOutputMultiset(frame.snapshot.utxoToCommit),
		decommitMultiset: partitionOutputMultiset(frame.snapshot.utxoToDecommit),
	};
}

/** Value-multiset of one signed snapshot partition (utxoToCommit/utxoToDecommit). */
function partitionOutputMultiset(partition: SnapshotUtxo | null | undefined): Map<string, number> {
	if (!partition) return new Map();
	const serialized: string[] = [];
	for (const output of Object.values(partition)) {
		serialized.push(serializeHydraSnapshotOutput(output));
	}
	return outputMultiset(serialized);
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
		// deposit), so a snapshot's own pending-commit outputs are legitimate
		// injections and the previous snapshot's pending-decommit outputs are
		// legitimate removals. Value still cannot appear or vanish through the
		// (unauthenticated) confirmed-tx list — that path stays bound by strict
		// created/consumed conservation and the externalInputCount tie below.
		const injectionAllowance = current.committedMultiset;
		const removalAllowance = previous.decommitMultiset;
		const allOutputs = new Set([
			...previous.outputMultiset.keys(),
			...current.outputMultiset.keys(),
			...survivingCreated.keys(),
			...injectionAllowance.keys(),
			...removalAllowance.keys(),
		]);
		let derivedConsumedOutputCount = 0;
		for (const output of allOutputs) {
			const previousCount = previous.outputMultiset.get(output) ?? 0;
			const createdCount = survivingCreated.get(output) ?? 0;
			const currentCount = current.outputMultiset.get(output) ?? 0;
			// Any surplus of `current` beyond what the previous state plus confirmed-tx
			// outputs can supply must be an authenticated incremental-commit deposit.
			const injectionNeeded = Math.max(0, currentCount - previousCount - createdCount);
			if (injectionNeeded > (injectionAllowance.get(output) ?? 0)) return false;
			// The remaining shortfall is confirmed-tx consumption from the previous
			// state, less any authenticated decommit removal (not a transaction input,
			// so it must not count toward externalInputCount).
			let consumed = previousCount + createdCount + injectionNeeded - currentCount;
			consumed -= Math.min(consumed, removalAllowance.get(output) ?? 0);
			if (!Number.isSafeInteger(consumed) || consumed < 0 || consumed > previousCount) {
				return false;
			}
			derivedConsumedOutputCount += consumed;
		}
		return derivedConsumedOutputCount === externalInputCount;
	} catch {
		return false;
	}
}
