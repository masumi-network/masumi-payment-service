import { describe, expect, it } from '@jest/globals';
import {
	Address,
	BigNum,
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
				},
			],
		});
	});

	it('returns null for CBOR that is not a transaction', () => {
		expect(readHydraSignedTransactionShape('00')).toBeNull();
		expect(readHydraSignedTransactionShape('zz')).toBeNull();
	});
});
