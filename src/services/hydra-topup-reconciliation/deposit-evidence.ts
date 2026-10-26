import { FixedTransaction, RedeemerTagKind } from '@emurgo/cardano-serialization-lib-nodejs';
import { resolveHydraDepositScriptHash } from '@/lib/hydra/hydra/commit-draft-validation';

export type HydraDepositReference = { txHash: string; outputIndex: number; address: string };

function readExactTransaction(cborHex: string, txHash: string): FixedTransaction | null {
	if (!/^[0-9a-f]{64}$/.test(txHash) || !/^(?:[0-9a-fA-F]{2})+$/.test(cborHex)) return null;
	const transaction = FixedTransaction.from_hex(cborHex);
	return transaction.is_valid() && transaction.transaction_hash().to_hex() === txHash ? transaction : null;
}

/** Identify the row's deposit from its immutable body, not an address prefix. */
export function findHydraDepositReference(params: {
	cborHex: string;
	txHash: string;
	headIdentifier: string;
	networkId: 0 | 1;
}): HydraDepositReference | null {
	try {
		if (!/^[0-9a-fA-F]{56}$/.test(params.headIdentifier)) return null;
		const transaction = readExactTransaction(params.cborHex, params.txHash);
		if (!transaction) return null;
		const outputs = transaction.body().outputs();
		const scriptHash = resolveHydraDepositScriptHash();
		let deposit: HydraDepositReference | null = null;
		for (let outputIndex = 0; outputIndex < outputs.len(); outputIndex += 1) {
			const output = outputs.get(outputIndex);
			if (output.address().payment_cred()?.to_scripthash()?.to_hex() !== scriptHash) continue;
			if (deposit !== null || output.address().network_id() !== params.networkId) return null;
			const datum = output.plutus_data()?.as_constr_plutus_data();
			if (!datum || datum.alternative().to_str() !== '0') return null;
			const fields = datum.data();
			if (fields.len() !== 3) return null;
			const headId = fields.get(0).as_bytes();
			if (!headId || Buffer.from(headId).toString('hex') !== params.headIdentifier.toLowerCase()) return null;
			if (!fields.get(1).as_integer() || !fields.get(2).as_list()) return null;
			deposit = { txHash: params.txHash, outputIndex, address: output.address().to_bech32() };
		}
		return deposit;
	} catch {
		return null;
	}
}

/**
 * Hydra 2.4.1 deposit.ak: Claim is constructor 0; Recover(Int) is constructor 1.
 * A recovery may include unrelated trailing outputs, including script outputs.
 */
export function classifyHydraDepositSpend(params: {
	cborHex: string;
	txHash: string;
	deposit: HydraDepositReference;
}): 'absorbed' | 'recovered' | null {
	try {
		const transaction = readExactTransaction(params.cborHex, params.txHash);
		if (!transaction) return null;
		const inputs = transaction.body().inputs();
		const references = Array.from({ length: inputs.len() }, (_unused, index) => {
			const input = inputs.get(index);
			return { txHash: input.transaction_id().to_hex(), outputIndex: input.index() };
		}).sort((a, b) => (a.txHash === b.txHash ? a.outputIndex - b.outputIndex : a.txHash < b.txHash ? -1 : 1));
		const matches = references.flatMap((reference, index) =>
			reference.txHash === params.deposit.txHash && reference.outputIndex === params.deposit.outputIndex ? [index] : [],
		);
		if (matches.length !== 1) return null;
		const redeemers = transaction.witness_set().redeemers();
		let outcome: 'absorbed' | 'recovered' | null = null;
		let matched = false;
		for (let index = 0; redeemers && index < redeemers.len(); index += 1) {
			const redeemer = redeemers.get(index);
			// Spend pointers index the canonical input set, never its CBOR order.
			if (redeemer.tag().kind() !== RedeemerTagKind.Spend || redeemer.index().to_str() !== String(matches[0])) continue;
			if (matched) return null;
			matched = true;
			const data = redeemer.data().as_constr_plutus_data();
			if (!data) return null;
			const fields = data.data();
			if (data.alternative().to_str() === '0' && fields.len() === 0) outcome = 'absorbed';
			if (data.alternative().to_str() === '1' && fields.len() === 1 && fields.get(0).as_integer())
				outcome = 'recovered';
		}
		return outcome;
	} catch {
		return null;
	}
}
