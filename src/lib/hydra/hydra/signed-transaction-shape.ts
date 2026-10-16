/**
 * The inputs and created outputs of one signed in-head transaction, in the
 * forms a verified snapshot uses: `txHash#index` references and canonical
 * Plutus `TxOut` bytes (`serializeCardanoTransactionOutput`). Read from the
 * transaction's own CBOR, so nothing here depends on what a node reports.
 */

import { FixedTransaction, type TransactionOutput } from '@emurgo/cardano-serialization-lib-nodejs';
import { serializeCardanoTransactionOutput } from './snapshot-serialization';

export type HydraSignedTransactionShape = {
	txHash: string;
	inputRefs: string[];
	outputs: Array<{
		reference: string;
		serializedOutput: string;
		/** The output's inline datum CBOR as signed, or null. */
		inlineDatumHex: string | null;
		/** Quantity per unit: `lovelace`, or policy id + asset name, both hex. */
		value: Map<string, bigint>;
	}>;
};

/** Null for CBOR that does not parse as a valid transaction. */
export function readHydraSignedTransactionShape(cborHex: string): HydraSignedTransactionShape | null {
	try {
		const transaction = FixedTransaction.from_bytes(Buffer.from(cborHex, 'hex'));
		if (!transaction.is_valid()) return null;
		const txHash = transaction.transaction_hash().to_hex().toLowerCase();
		const body = transaction.body();
		const inputs = body.inputs();
		const inputRefs: string[] = [];
		for (let index = 0; index < inputs.len(); index += 1) {
			const input = inputs.get(index);
			inputRefs.push(`${input.transaction_id().to_hex()}#${input.index()}`.toLowerCase());
		}
		const outputs = body.outputs();
		const shapedOutputs: HydraSignedTransactionShape['outputs'] = [];
		for (let index = 0; index < outputs.len(); index += 1) {
			const output = outputs.get(index);
			const inlineDatum = output.plutus_data();
			shapedOutputs.push({
				reference: `${txHash}#${index}`,
				serializedOutput: serializeCardanoTransactionOutput(output),
				inlineDatumHex: inlineDatum ? Buffer.from(inlineDatum.to_bytes()).toString('hex') : null,
				value: outputValue(output),
			});
		}
		return { txHash, inputRefs, outputs: shapedOutputs };
	} catch {
		return null;
	}
}

function outputValue(output: TransactionOutput): Map<string, bigint> {
	const amount = output.amount();
	const value = new Map<string, bigint>([['lovelace', BigInt(amount.coin().to_str())]]);
	const multiasset = amount.multiasset();
	const policies = multiasset?.keys();
	for (let policyIndex = 0; policies && policyIndex < policies.len(); policyIndex += 1) {
		const policy = policies.get(policyIndex);
		const assets = multiasset?.get(policy);
		const names = assets?.keys();
		for (let nameIndex = 0; names && nameIndex < names.len(); nameIndex += 1) {
			const name = names.get(nameIndex);
			const quantity = assets?.get(name);
			// `name()` is the raw name; `to_hex()` would CBOR-wrap it.
			const unit = `${policy.to_hex()}${Buffer.from(name.name()).toString('hex')}`.toLowerCase();
			if (quantity) value.set(unit, BigInt(quantity.to_str()));
		}
	}
	return value;
}
