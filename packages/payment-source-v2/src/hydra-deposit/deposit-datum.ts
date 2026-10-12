// Mesh SDK pinning: V2 package, V2 mesh line (ADR 0005).
//
// Reads a Hydra deposit datum back into the outputs a recover must recreate.
// The layout is hydra 2.4.1 `Hydra.Contract.Deposit.DepositDatum`
// (`(CurrencySymbol, POSIXTime, [Commit])`) and `Hydra.Contract.Commit.Commit`
// (`{ input :: TxOutRef, preSerializedOutput :: BuiltinByteString }`), where
// `preSerializedOutput` is `serialise (toData txOut)` of a Plutus V3 TxOut.
import {
	BaseAddress,
	CredentialType,
	EnterpriseAddress,
	Hash28ByteBase16,
	HexBlob,
	PlutusData,
	PlutusDataKind,
} from '@meshsdk/core-cst';
import type { Asset } from '@meshsdk/core';

export type RecoveredOutput = {
	address: string;
	amount: Asset[];
	/** Inline datum CBOR, or null for an output without a datum. */
	inlineDatumCbor: string | null;
};

export type DepositCommit = { txHash: string; outputIndex: number; output: RecoveredOutput };

export type DepositDatum = { headId: string; deadlineMs: bigint; commits: DepositCommit[] };

/** 0 = testnets, 1 = mainnet. */
export type CardanoNetworkId = 0 | 1;

/** The deposit datum does not have the layout a recover can rebuild. */
export class DepositDatumError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DepositDatumError';
	}
}

function fail(message: string): never {
	throw new DepositDatumError(message);
}

function fromCbor(hex: string, label: string): PlutusData {
	try {
		return PlutusData.fromCbor(HexBlob(hex));
	} catch {
		fail(`${label} is not valid Plutus data CBOR`);
	}
}

function alternativeOf(data: PlutusData, label: string): bigint {
	if (data.getKind() !== PlutusDataKind.ConstrPlutusData) fail(`${label} is not a constructor`);
	return data.asConstrPlutusData()!.getAlternative();
}

function constr(data: PlutusData, label: string, alternative: bigint, arity: number): PlutusData[] {
	const actual = alternativeOf(data, label);
	if (actual !== alternative) fail(`${label} has constructor ${actual}, expected ${alternative}`);
	const fields = data.asConstrPlutusData()!.getData();
	if (fields.getLength() !== arity) fail(`${label} has ${fields.getLength()} fields, expected ${arity}`);
	return Array.from({ length: arity }, (_, index) => fields.get(index));
}

function bytes(data: PlutusData, label: string, length?: number): string {
	if (data.getKind() !== PlutusDataKind.Bytes) fail(`${label} is not a byte string`);
	const value = Buffer.from(data.asBoundedBytes()!).toString('hex');
	if (length !== undefined && value.length !== length * 2) fail(`${label} is not ${length} bytes`);
	return value;
}

function integer(data: PlutusData, label: string): bigint {
	if (data.getKind() !== PlutusDataKind.Integer) fail(`${label} is not an integer`);
	return data.asInteger()!;
}

function items(data: PlutusData, label: string): PlutusData[] {
	if (data.getKind() !== PlutusDataKind.List) fail(`${label} is not a list`);
	const value = data.asList()!;
	return Array.from({ length: value.getLength() }, (_, index) => value.get(index));
}

function entries(data: PlutusData, label: string): Array<[PlutusData, PlutusData]> {
	if (data.getKind() !== PlutusDataKind.Map) fail(`${label} is not a map`);
	const map = data.asMap()!;
	const keys = map.getKeys();
	return Array.from({ length: keys.getLength() }, (_, index): [PlutusData, PlutusData] => {
		const key = keys.get(index);
		const value = map.get(key);
		if (value === undefined) fail(`${label} has a key without a value`);
		return [key, value];
	});
}

// PlutusV3 Credential: PubKeyCredential (0) | ScriptCredential (1).
function credential(data: PlutusData, label: string) {
	const alternative = alternativeOf(data, label);
	if (alternative !== 0n && alternative !== 1n) fail(`${label} has unknown constructor ${alternative}`);
	const [hash] = constr(data, label, alternative, 1);
	return {
		type: alternative === 0n ? CredentialType.KeyHash : CredentialType.ScriptHash,
		hash: Hash28ByteBase16(bytes(hash, `${label} hash`, 28)),
	};
}

// PlutusV3 Address: Constr 0 [Credential, Maybe StakingCredential]. A stake
// pointer has no base address form, so it is refused rather than guessed.
function address(data: PlutusData, networkId: CardanoNetworkId): string {
	const [paymentData, stakeData] = constr(data, 'address', 0n, 2);
	const payment = credential(paymentData, 'payment credential');
	if (alternativeOf(stakeData, 'stake part') === 1n) {
		constr(stakeData, 'stake part', 1n, 0);
		return EnterpriseAddress.fromCredentials(networkId, payment).toAddress().toBech32();
	}
	const [staking] = constr(stakeData, 'stake part', 0n, 1);
	if (alternativeOf(staking, 'staking credential') !== 0n) fail('a stake pointer address cannot be recovered');
	const [stakeCredential] = constr(staking, 'staking credential', 0n, 1);
	return BaseAddress.fromCredentials(networkId, payment, credential(stakeCredential, 'stake credential'))
		.toAddress()
		.toBech32();
}

// PlutusV3 Value: Map CurrencySymbol (Map TokenName Integer); ADA is "" / "".
function value(data: PlutusData): Asset[] {
	const assets: Asset[] = [];
	for (const [policyData, tokens] of entries(data, 'value')) {
		const policy = bytes(policyData, 'policy id');
		if (policy.length !== 0 && policy.length !== 56) fail('policy id is not 28 bytes');
		for (const [nameData, quantityData] of entries(tokens, 'token map')) {
			const name = bytes(nameData, 'token name');
			const quantity = integer(quantityData, 'quantity');
			if (quantity <= 0n) fail('value holds a non-positive quantity');
			if (policy.length === 0 && name.length !== 0) fail('ADA entry has a token name');
			assets.push({ unit: policy.length === 0 ? 'lovelace' : `${policy}${name}`, quantity: quantity.toString() });
		}
	}
	if (!assets.some((asset) => asset.unit === 'lovelace')) fail('value holds no ADA');
	return assets;
}

/**
 * One committed output. The datum keeps only the hash of a datum hash's datum
 * and of a reference script, so neither can be rebuilt; both are refused.
 */
export function decodeCommittedOutput(preSerializedOutputHex: string, networkId: CardanoNetworkId): RecoveredOutput {
	const data = fromCbor(preSerializedOutputHex, 'committed output');
	const [addressData, valueData, datumData, scriptData] = constr(data, 'committed output', 0n, 4);
	if (alternativeOf(scriptData, 'reference script') !== 1n) fail('a committed reference script cannot be recovered');
	constr(scriptData, 'reference script', 1n, 0);
	// OutputDatum: NoOutputDatum (0) | OutputDatumHash (1) | OutputDatum (2).
	const datumKind = alternativeOf(datumData, 'output datum');
	let inlineDatumCbor: string | null = null;
	if (datumKind === 2n) {
		const [inline] = constr(datumData, 'output datum', 2n, 1);
		inlineDatumCbor = inline.toCbor();
	} else if (datumKind === 0n) {
		constr(datumData, 'output datum', 0n, 0);
	} else {
		fail('a committed datum hash cannot be recovered');
	}
	return { address: address(addressData, networkId), amount: value(valueData), inlineDatumCbor };
}

/** Parse an inline deposit datum. Commits come back in the order the validator hashes them. */
export function parseDepositDatum(datumCbor: string, networkId: CardanoNetworkId): DepositDatum {
	const data = fromCbor(datumCbor, 'deposit datum');
	const [headIdData, deadlineData, commitsData] = constr(data, 'deposit datum', 0n, 3);
	const commits = items(commitsData, 'commits').map((commit, index): DepositCommit => {
		const [inputData, outputData] = constr(commit, `commit ${index}`, 0n, 2);
		const [txIdData, indexData] = constr(inputData, `commit ${index} input`, 0n, 2);
		const outputIndex = integer(indexData, `commit ${index} output index`);
		if (outputIndex < 0n || outputIndex > 65_535n) fail(`commit ${index} output index is out of range`);
		return {
			txHash: bytes(txIdData, `commit ${index} tx id`, 32),
			outputIndex: Number(outputIndex),
			output: decodeCommittedOutput(bytes(outputData, `commit ${index} output`), networkId),
		};
	});
	if (commits.length === 0) fail('deposit datum commits nothing');
	// deposit.ak hashes the commits sorted by output reference and compares the
	// hash with the first outputs in transaction order, so outputs follow this order.
	commits.sort(compareOutputReference);
	return { headId: bytes(headIdData, 'head id', 28), deadlineMs: integer(deadlineData, 'deadline'), commits };
}

// Aiken `output_reference.compare`: transaction id bytes, then output index.
function compareOutputReference(a: DepositCommit, b: DepositCommit): number {
	if (a.txHash !== b.txHash) return a.txHash < b.txHash ? -1 : 1;
	return a.outputIndex - b.outputIndex;
}
