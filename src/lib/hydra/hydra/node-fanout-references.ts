/**
 * Resolving a surviving in-head output to the exact L1 output the Hydra chain
 * follower observed at fanout, from evidence the node has already verified:
 * the signed final snapshot, the finalized fanout output map, and the retained
 * producer transaction CBOR. The availability gates (pinned sessions, Final
 * status, expected snapshot number) stay with the session that owns that
 * state; this module owns only the resolution itself.
 */

import { FixedTransaction } from '@emurgo/cardano-serialization-lib-nodejs';
import {
	resolveVerifiedHydraFanoutReference,
	resolveVerifiedHydraFanoutReferences,
	serializeCardanoTransactionOutput,
	type VerifiedHydraFanoutReference,
	type VerifiedHydraSnapshot,
} from './snapshot-verification';
import { HydraConfirmedTransaction } from './types';

export interface FanoutResolutionContext {
	verifiedSnapshot: VerifiedHydraSnapshot;
	finalizedFanoutOutputs: Map<string, string>;
	getConfirmedTransaction: (txHash: string) => HydraConfirmedTransaction | null;
}

export function resolveNodeFanoutReference(
	context: FanoutResolutionContext,
	hydraReference: string,
): VerifiedHydraFanoutReference | null {
	const separator = hydraReference.indexOf('#');
	if (separator <= 0 || hydraReference.indexOf('#', separator + 1) !== -1) return null;
	const producerTxHash = hydraReference.slice(0, separator).toLowerCase();
	const outputIndexText = hydraReference.slice(separator + 1);
	if (!/^[0-9a-f]{64}$/.test(producerTxHash) || !/^(?:0|[1-9][0-9]*)$/.test(outputIndexText)) return null;
	const outputIndex = Number(outputIndexText);
	if (!Number.isSafeInteger(outputIndex) || outputIndex < 0 || outputIndex > 0xffffffff) return null;
	const confirmedProducer = context.getConfirmedTransaction(producerTxHash);
	if (!confirmedProducer) return null;
	let serializedOutput: string;
	try {
		const transaction = FixedTransaction.from_bytes(Buffer.from(confirmedProducer.cborHex, 'hex'));
		if (!transaction.is_valid() || transaction.transaction_hash().to_hex().toLowerCase() !== producerTxHash) {
			return null;
		}
		const outputs = transaction.body().outputs();
		if (outputIndex >= outputs.len()) return null;
		serializedOutput = serializeCardanoTransactionOutput(outputs.get(outputIndex));
	} catch {
		return null;
	}
	return resolveVerifiedHydraFanoutReference(
		context.verifiedSnapshot,
		context.finalizedFanoutOutputs,
		serializedOutput,
	);
}

export function resolveNodeFanoutReferences(context: FanoutResolutionContext): VerifiedHydraFanoutReference[] | null {
	return resolveVerifiedHydraFanoutReferences(context.verifiedSnapshot, context.finalizedFanoutOutputs);
}
