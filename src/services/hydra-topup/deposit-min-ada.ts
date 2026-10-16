import {
	Address,
	AssetName,
	Assets,
	BigInt as CardanoBigInt,
	BigNum,
	ConstrPlutusData,
	Credential,
	DataCost,
	EnterpriseAddress,
	MultiAsset,
	PlutusData,
	PlutusList,
	PlutusMap,
	PlutusMapValues,
	ScriptHash,
	TransactionOutput,
	Value,
	min_ada_for_output,
} from '@emurgo/cardano-serialization-lib-nodejs';
import { DEFAULT_HYDRA_DEPOSIT_SCRIPT_HASH } from '@/lib/hydra/hydra/commit-draft-validation';

// These placeholders cover the serialized widths before the carve has a tx id.
const MAX_OUTPUT_INDEX = 0xffff_ffffn;
const MAX_DEADLINE_MS = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * Minimum for one plain token UTxO AND its later Hydra deposit output.
 * Hydra 2.4.1 Deposit.hs:177-190 requires exact value equality, even when its
 * wallet pads an undersized deposit. Include that ADA in the original UTxO.
 */
export function calculateTokenDepositMinLovelace({
	walletAddress,
	unit,
	amount,
	coinsPerUtxoSize,
}: {
	walletAddress: string;
	unit: string;
	amount: bigint;
	coinsPerUtxoSize: number;
}): bigint {
	if (!/^[0-9a-f]{56,120}$/i.test(unit) || unit.length % 2 !== 0) {
		throw new Error('token deposit requires a valid policy id and asset name');
	}
	if (amount <= 0n || amount > 0xffff_ffff_ffff_ffffn) {
		throw new Error('token deposit quantity must be a positive uint64');
	}
	if (!Number.isSafeInteger(coinsPerUtxoSize) || coinsPerUtxoSize <= 0) {
		throw new Error('token deposit requires a positive integer coinsPerUtxoSize');
	}
	const address = Address.from_bech32(walletAddress);
	const depositAddress = EnterpriseAddress.new(
		address.network_id(),
		Credential.from_scripthash(ScriptHash.from_hex(DEFAULT_HYDRA_DEPOSIT_SCRIPT_HASH)),
	).to_address();
	const cost = DataCost.new_coins_per_byte(BigNum.from_str(String(coinsPerUtxoSize)));
	const policy = Buffer.from(unit.slice(0, 56), 'hex');
	const name = Buffer.from(unit.slice(56), 'hex');
	const assets = Assets.new();
	assets.insert(AssetName.new(name), BigNum.from_str(amount.toString()));
	const multiAsset = MultiAsset.new();
	multiAsset.insert(ScriptHash.from_bytes(policy), assets);

	let lovelace = 0n;
	for (;;) {
		const value = Value.new(BigNum.from_str(lovelace.toString()));
		value.set_multiasset(multiAsset);
		const serializedOutput = constructor(0, [
			PlutusData.from_address(address),
			map([
				[Buffer.alloc(0), map([[Buffer.alloc(0), integer(lovelace)]])],
				[policy, map([[name, integer(amount)]])],
			]),
			constructor(0, []), // NoOutputDatum
			constructor(1, []), // Nothing: reference script
		]).to_bytes();
		const commits = PlutusList.new();
		commits.add(
			constructor(0, [
				constructor(0, [PlutusData.new_bytes(Buffer.alloc(32)), integer(MAX_OUTPUT_INDEX)]),
				PlutusData.new_bytes(serializedOutput),
			]),
		);
		const deposit = TransactionOutput.new(depositAddress, value);
		deposit.set_plutus_data(
			constructor(0, [PlutusData.new_bytes(Buffer.alloc(28)), integer(MAX_DEADLINE_MS), PlutusData.new_list(commits)]),
		);
		const walletMinimum = BigInt(min_ada_for_output(TransactionOutput.new(address, value), cost).to_str());
		const depositMinimum = BigInt(min_ada_for_output(deposit, cost).to_str());
		const required = walletMinimum > depositMinimum ? walletMinimum : depositMinimum;
		if (lovelace >= required) return lovelace;
		lovelace = required;
	}
}

function integer(value: bigint): PlutusData {
	return PlutusData.new_integer(CardanoBigInt.from_str(value.toString()));
}

function constructor(index: number, fields: PlutusData[]): PlutusData {
	const list = PlutusList.new();
	for (const field of fields) list.add(field);
	return PlutusData.new_constr_plutus_data(ConstrPlutusData.new(BigNum.from_str(String(index)), list));
}

function map(entries: Array<[Buffer, PlutusData]>): PlutusData {
	const result = PlutusMap.new();
	for (const [key, value] of entries) {
		const values = PlutusMapValues.new();
		values.add(value);
		result.insert(PlutusData.new_bytes(key), values);
	}
	return PlutusData.new_map(result);
}
