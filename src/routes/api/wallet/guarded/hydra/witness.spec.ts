import { describe, expect, it } from '@jest/globals';
import {
	Address,
	BigNum,
	FixedTransaction,
	PrivateKey,
	TransactionBody,
	TransactionHash,
	TransactionInput,
	TransactionInputs,
	TransactionOutput,
	TransactionOutputs,
	Value,
	make_vkey_witness,
} from '@emurgo/cardano-serialization-lib-nodejs';
import { hasValidKeyWitness } from './witness';

const OUTPUT_ADDRESS = 'addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz';

function unsignedTx(inputTxHash: string): FixedTransaction {
	const inputs = TransactionInputs.new();
	inputs.add(TransactionInput.new(TransactionHash.from_hex(inputTxHash), 0));
	const outputs = TransactionOutputs.new();
	outputs.add(TransactionOutput.new(Address.from_bech32(OUTPUT_ADDRESS), Value.new(BigNum.from_str('2000000'))));
	const body = TransactionBody.new_tx_body(inputs, outputs, BigNum.from_str('170000'));
	return FixedTransaction.new_from_body_bytes(body.to_bytes());
}

function signedTx(key: PrivateKey, inputTxHash = '0'.repeat(64)) {
	const tx = unsignedTx(inputTxHash);
	tx.sign_and_add_vkey_signature(key);
	return { hex: tx.to_hex(), txHash: tx.transaction_hash().to_hex() };
}

describe('hasValidKeyWitness', () => {
	const signer = PrivateKey.generate_ed25519();
	const signerKeyHash = signer.to_public().hash().to_hex();

	it('accepts a witness from the signer key over the body hash', () => {
		const { hex, txHash } = signedTx(signer);
		expect(hasValidKeyWitness(hex, txHash, signerKeyHash)).toBe(true);
		expect(hasValidKeyWitness(hex, txHash, signerKeyHash.toUpperCase())).toBe(true);
	});

	it('rejects a key hash that did not sign', () => {
		const { hex, txHash } = signedTx(signer);
		const otherKeyHash = PrivateKey.generate_ed25519().to_public().hash().to_hex();
		expect(hasValidKeyWitness(hex, txHash, otherKeyHash)).toBe(false);
	});

	it('rejects an unsigned transaction', () => {
		const tx = unsignedTx('0'.repeat(64));
		expect(hasValidKeyWitness(tx.to_hex(), tx.transaction_hash().to_hex(), signerKeyHash)).toBe(false);
	});

	it('rejects a witness by the signer key over a different body hash', () => {
		const tx = unsignedTx('0'.repeat(64));
		const otherBodyHash = unsignedTx('1'.repeat(64)).transaction_hash();
		tx.add_vkey_witness(make_vkey_witness(otherBodyHash, signer));
		expect(hasValidKeyWitness(tx.to_hex(), tx.transaction_hash().to_hex(), signerKeyHash)).toBe(false);
	});

	it('rejects a valid witness when checked against another tx hash', () => {
		const { hex } = signedTx(signer);
		const otherTxHash = unsignedTx('1'.repeat(64)).transaction_hash().to_hex();
		expect(hasValidKeyWitness(hex, otherTxHash, signerKeyHash)).toBe(false);
	});
});
