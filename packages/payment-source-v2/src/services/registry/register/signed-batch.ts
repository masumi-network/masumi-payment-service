import type { BatchRegistryMintItem } from '../../../builders/batch-registry';
import { assertSignedL1TxSizeWithinProtocolLimit, getL1MaxTxSize } from '../../../builders/batch-helpers';

type MintBudget = { mem: number; steps: number };
type EvaluationAction = { tag?: string; budget: MintBudget };

/** Build the largest prefix whose complete signed transaction fits L1. */
export async function buildSignedRegistryMintPrefix(
	items: BatchRegistryMintItem[],
	protocolParameters: unknown,
	buildEvaluationTx: (subset: BatchRegistryMintItem[]) => Promise<string>,
	evaluateTx: (tx: string) => Promise<EvaluationAction[]>,
	buildFinalTx: (subset: BatchRegistryMintItem[], budget: MintBudget) => Promise<string>,
	signTx: (unsignedTx: string) => Promise<string>,
): Promise<{ fitCount: number; unsignedTx: string; signedTx: string } | null> {
	const label = 'v2-registry-batch-mint';
	const maxTxSize = getL1MaxTxSize(protocolParameters, label);
	for (let fitCount = items.length; fitCount > 0; fitCount--) {
		const subset = items.slice(0, fitCount);
		const evaluationTx = await buildEvaluationTx(subset);
		// The node may reject an oversized evaluation transaction before it
		// returns a redeemer budget. The final signed size decides acceptance.
		if (evaluationTx.length / 2 > maxTxSize) continue;

		const estimatedFee = await evaluateTx(evaluationTx);
		const mintBudget = estimatedFee.find((action) => action.tag === 'MINT')?.budget ?? estimatedFee[0]?.budget;
		if (mintBudget == null) {
			throw new Error('evaluateTx returned no MINT budget for V2 register batch');
		}
		const unsignedTx = await buildFinalTx(subset, mintBudget);
		if (unsignedTx.length / 2 > maxTxSize) continue;
		const signedTx = await signTx(unsignedTx);
		if (signedTx.length / 2 > maxTxSize && signedTx.length % 2 === 0) continue;
		assertSignedL1TxSizeWithinProtocolLimit(signedTx, protocolParameters, label);
		return { fitCount, unsignedTx, signedTx };
	}
	return null;
}
