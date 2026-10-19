import { describe, expect, it } from '@jest/globals';
import {
	Address,
	AssetName,
	Assets,
	BigNum,
	MultiAsset,
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
} from '@emurgo/cardano-serialization-lib-nodejs';
import { resolveTxHash } from '@meshsdk/core';
import { readHydraSignedTransactionShape } from './signed-transaction-shape';
import { serializeHydraSnapshotOutput } from './snapshot-verification';

const ADDRESS =
	'addr_test1qp6ctf8vcjxzd53et7p0hlqyncn59stnfd4g8mp978v33r6dlzjvt4s2t6wn3v993pu9aea4h3z0jeyn6lsvw6hugtesfx55dd';

describe('readHydraSignedTransactionShape', () => {
	it('reads inputs and outputs in snapshot key form', () => {
		const inputs = TransactionInputs.new();
		inputs.add(TransactionInput.new(TransactionHash.from_hex('AB'.repeat(32)), 3));
		const outputs = TransactionOutputs.new();
		outputs.add(TransactionOutput.new(Address.from_bech32(ADDRESS), Value.new(BigNum.from_str('2000000'))));
		const cborHex = Transaction.new(
			TransactionBody.new_tx_body(inputs, outputs, BigNum.zero()),
			TransactionWitnessSet.new(),
		).to_hex();
		const txHash = String(resolveTxHash(cborHex)).toLowerCase();

		expect(readHydraSignedTransactionShape(cborHex)).toEqual({
			txHash,
			inputRefs: [`${'ab'.repeat(32)}#3`],
			outputs: [
				{
					reference: `${txHash}#0`,
					serializedOutput: serializeHydraSnapshotOutput({
						address: ADDRESS,
						value: { lovelace: 2_000_000 },
						referenceScript: null,
						datum: null,
						datumhash: null,
						inlineDatum: null,
						inlineDatumRaw: null,
						inlineDatumhash: null,
					}),
					inlineDatumHex: null,
					value: new Map([['lovelace', 2_000_000n]]),
				},
			],
		});
	});

	it('reads each unit of an output value with the raw asset name', () => {
		const inputs = TransactionInputs.new();
		inputs.add(TransactionInput.new(TransactionHash.from_hex('cd'.repeat(32)), 0));
		const multiasset = MultiAsset.new();
		const assets = Assets.new();
		assets.insert(AssetName.new(Buffer.from('token', 'utf8')), BigNum.from_str('7'));
		multiasset.insert(ScriptHash.from_hex('ab'.repeat(28)), assets);
		const value = Value.new_with_assets(BigNum.from_str('3000000'), multiasset);
		const outputs = TransactionOutputs.new();
		outputs.add(TransactionOutput.new(Address.from_bech32(ADDRESS), value));
		const cborHex = Transaction.new(
			TransactionBody.new_tx_body(inputs, outputs, BigNum.zero()),
			TransactionWitnessSet.new(),
		).to_hex();

		expect(readHydraSignedTransactionShape(cborHex)?.outputs[0].value).toEqual(
			new Map([
				['lovelace', 3_000_000n],
				[`${'ab'.repeat(28)}746f6b656e`, 7n],
			]),
		);
	});

	it('returns null for CBOR that is not a transaction', () => {
		expect(readHydraSignedTransactionShape('00')).toBeNull();
		expect(readHydraSignedTransactionShape('zz')).toBeNull();
	});
});
