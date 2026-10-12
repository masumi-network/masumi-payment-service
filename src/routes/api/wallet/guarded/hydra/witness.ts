import { FixedTransaction } from '@emurgo/cardano-serialization-lib-nodejs';

/**
 * True when the transaction carries a valid vkey witness from `keyHash` over its
 * body. Signing never changes the body, so `txHash` is the id the service built
 * and recorded, not one read back from the signed bytes.
 */
export function hasValidKeyWitness(signedTxHex: string, txHash: string, keyHash: string): boolean {
	const vkeys = FixedTransaction.from_hex(signedTxHex).witness_set().vkeys();
	if (vkeys == null) return false;
	const message = Buffer.from(txHash, 'hex');
	for (let index = 0; index < vkeys.len(); index += 1) {
		const witness = vkeys.get(index);
		const publicKey = witness.vkey().public_key();
		if (publicKey.hash().to_hex() === keyHash.toLowerCase() && publicKey.verify(message, witness.signature())) {
			return true;
		}
	}
	return false;
}
