/**
 * Canonical Plutus `TxOut` serialization for Hydra snapshot outputs.
 *
 * Split out of `snapshot-verification.ts`, which is the public face of snapshot
 * verification and had grown past this repository's file-size ceiling. Nothing
 * here decides anything: it turns one output — as a hydra-node snapshot
 * declares it, or as the cardano-serialization-lib parses it off a transaction
 * — into the exact bytes Hydra's own accumulator and signature hash over. The
 * two entry points must agree byte for byte, because a snapshot's UTxO set and
 * the transactions that produced it are compared through them.
 */
import {
	Address,
	BaseAddress,
	CredKind,
	EnterpriseAddress,
	PointerAddress,
	NativeScript,
	PlutusScript,
	type Credential,
	type TransactionOutput,
} from '@emurgo/cardano-serialization-lib-nodejs';
import { blake2b } from 'ethereum-cryptography/blake2b.js';
import { Constr, Data, type Data as LucidData } from 'lucid-cardano';

import { HydraProtocolError } from './errors';
import { HydraScriptLanguage, type HydraQuantity, type HydraReferenceScript, type HydraValue } from './types';

export type SnapshotOutput = {
	address: string;
	value: HydraValue;
	referenceScript: HydraReferenceScript | null;
	datumhash?: string | null;
	inlineDatumhash?: string | null;
	inlineDatum: unknown;
	inlineDatumRaw: string | null;
	datum: string | null;
};

export type SnapshotUtxo = Record<string, SnapshotOutput>;

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
