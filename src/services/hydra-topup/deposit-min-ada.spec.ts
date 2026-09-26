import { describe, expect, it } from '@jest/globals';
import {
	Address,
	BigInt as CardanoBigInt,
	BigNum,
	ConstrPlutusData,
	PlutusList,
	Credential,
	DataCost,
	EnterpriseAddress,
	PlutusData,
	ScriptHash,
	Transaction,
	TransactionBody,
	TransactionHash,
	TransactionInput,
	TransactionInputs,
	TransactionOutput,
	TransactionOutputs,
	TransactionWitnessSet,
	Value,
	min_ada_for_output,
} from '@emurgo/cardano-serialization-lib-nodejs';
import { calculateTokenDepositMinLovelace } from './deposit-min-ada';
import { DEFAULT_HYDRA_DEPOSIT_SCRIPT_HASH, validateHydraCommitDraft } from '@/lib/hydra/hydra/commit-draft-validation';
import { HydraTransactionType } from '@/lib/hydra/hydra/types';

const ADDRESS =
	'addr_test1qp6ctf8vcjxzd53et7p0hlqyncn59stnfd4g8mp978v33r6dlzjvt4s2t6wn3v993pu9aea4h3z0jeyn6lsvw6hugtesfx55dd';
const POLICY = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde';
const NAME = '0014df10745553444d';
const OPTIONS = { walletAddress: ADDRESS, unit: POLICY + NAME, amount: 2_000_000_000n, coinsPerUtxoSize: 4310 };

// Existing upstream-shaped serialized TxOut fixture, with the coin filled below.
const SERIALIZED_OUTPUT =
	'd8799fd8799fd8799f581c7585a4ecc48c26d2395f82fbfc049e2742c1734b6a83ec25f1d9188fffd8799fd8799fd8799f581c4df8a4c5d60a5e9d38b0a588785ee7b5bc44f96493d7e0c76afc42f3ffffffffa240a1401aCOIN581c16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722dddea1490014df10745553444d1a77359400d87980d87a80ff';

function makeDeposit(lovelace: bigint, outputIndex: number, deadline: number) {
	const serialized = SERIALIZED_OUTPUT.replace('COIN', lovelace.toString(16).padStart(8, '0'));
	const commits = PlutusList.new();
	commits.add(
		constructor(0, [
			constructor(0, [
				PlutusData.new_bytes(Buffer.alloc(32)),
				PlutusData.new_integer(CardanoBigInt.from_str(String(outputIndex))),
			]),
			PlutusData.new_bytes(Buffer.from(serialized, 'hex')),
		]),
	);
	const datum = constructor(0, [
		PlutusData.new_bytes(Buffer.alloc(28)),
		PlutusData.new_integer(CardanoBigInt.from_str(String(deadline))),
		PlutusData.new_list(commits),
	]);
	const value = Value.from_hex(`821a${lovelace.toString(16).padStart(8, '0')}a1581c${POLICY}a149${NAME}1a77359400`);
	const depositAddress = EnterpriseAddress.new(
		0,
		Credential.from_scripthash(ScriptHash.from_hex(DEFAULT_HYDRA_DEPOSIT_SCRIPT_HASH)),
	).to_address();
	const output = TransactionOutput.new(depositAddress, value);
	output.set_plutus_data(datum);
	return { output, value };
}

describe('calculateTokenDepositMinLovelace', () => {
	it.each([
		{ outputIndex: 0xffff_ffff, nowMs: Number.MAX_SAFE_INTEGER - 120_000 },
		{ outputIndex: 1, nowMs: 1_800_000_000_000 },
	])('covers the deposit and wallet minima for reference index $outputIndex', ({ outputIndex, nowMs }) => {
		const lovelace = calculateTokenDepositMinLovelace(OPTIONS);
		const { output, value } = makeDeposit(lovelace, outputIndex, nowMs + 120_000);
		const cost = DataCost.new_coins_per_byte(BigNum.from_str('4310'));
		expect(lovelace).toBeGreaterThanOrEqual(BigInt(min_ada_for_output(output, cost).to_str()));
		const walletMinimum = BigInt(
			min_ada_for_output(TransactionOutput.new(Address.from_bech32(ADDRESS), value), cost).to_str(),
		);
		expect(lovelace).toBeGreaterThan(walletMinimum);
		const inputs = TransactionInputs.new();
		inputs.add(TransactionInput.new(TransactionHash.from_hex('00'.repeat(32)), outputIndex));
		inputs.add(TransactionInput.new(TransactionHash.from_hex('11'.repeat(32)), 0));
		const outputs = TransactionOutputs.new();
		outputs.add(output);
		outputs.add(TransactionOutput.new(Address.from_bech32(ADDRESS), Value.new(BigNum.from_str('2000000'))));
		const body = TransactionBody.new(inputs, outputs, BigNum.from_str('200000'));
		body.set_ttl(BigNum.from_str('1'));
		const draft = Transaction.new(body, TransactionWitnessSet.new());
		expect(() =>
			validateHydraCommitDraft({
				draft: { type: HydraTransactionType.TxConwayEra, description: '', cborHex: draft.to_hex() },
				commitUtxos: [
					{
						input: { txHash: '00'.repeat(32), outputIndex },
						output: {
							address: ADDRESS,
							amount: [
								{ unit: 'lovelace', quantity: String(lovelace) },
								{ unit: POLICY + NAME, quantity: String(OPTIONS.amount) },
							],
						},
					},
				],
				walletUtxos: [],
				expectedHeadId: '00'.repeat(28),
				nowMs,
				slotConfig: { zeroTime: nowMs, zeroSlot: 0, slotLength: 1000, startEpoch: 0, epochLength: 432000 },
			}),
		).not.toThrow();
	});

	it('accounts for longer asset names and increased protocol byte costs', () => {
		const base = calculateTokenDepositMinLovelace(OPTIONS);
		expect(calculateTokenDepositMinLovelace({ ...OPTIONS, unit: POLICY + 'ab'.repeat(32) })).toBeGreaterThan(base);
		expect(calculateTokenDepositMinLovelace({ ...OPTIONS, coinsPerUtxoSize: 8620 })).toBeGreaterThanOrEqual(base * 2n);
	});

	it.each([0, -1, 1.5, Number.NaN])('rejects invalid byte cost %s', (coinsPerUtxoSize) => {
		expect(() => calculateTokenDepositMinLovelace({ ...OPTIONS, coinsPerUtxoSize })).toThrow('coinsPerUtxoSize');
	});

	it('rejects invalid units and quantities', () => {
		expect(() => calculateTokenDepositMinLovelace({ ...OPTIONS, unit: 'lovelace' })).toThrow('policy id');
		expect(() => calculateTokenDepositMinLovelace({ ...OPTIONS, unit: POLICY + 'a' })).toThrow('policy id');
		expect(() => calculateTokenDepositMinLovelace({ ...OPTIONS, amount: 0n })).toThrow('quantity');
	});
});

function constructor(index: number, fields: PlutusData[]): PlutusData {
	const list = PlutusList.new();
	for (const field of fields) list.add(field);
	return PlutusData.new_constr_plutus_data(ConstrPlutusData.new(BigNum.from_str(String(index)), list));
}
