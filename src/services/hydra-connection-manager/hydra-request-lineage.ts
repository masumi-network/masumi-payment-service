/**
 * Whether a duplicate script output can touch a local escrow's lineage.
 *
 * Pure and dependency-free so both the confirmed-tx path and the live-UTxO
 * reconciler can share it without loading the datum flow.
 */

export type HydraOutputReference = { txHash: string; outputIndex: number };

/** The persisted lineage of one local escrow row that shares an identifier. */
export type HydraRequestLineage = {
	currentHydraUtxoTxHash: string | null;
	currentHydraUtxoOutputIndex: number | null;
	CurrentTransaction: { txHash: string | null; intendedTxHash: string | null; hydraHeadId: string | null } | null;
	TransactionHistory: Array<{ txHash: string | null }>;
};

/**
 * A confirmed transaction belongs to a local escrow's lineage only when the
 * escrow recorded it, or when its body consumes the escrow's persisted output.
 * Any other transaction can never pass observationHasValidLineage for that row,
 * so its duplicate outputs are a peer's copy, not ambiguity in local state.
 * Without decoded inputs the binding cannot be ruled out.
 */
export function isTransactionBoundToHydraLineage(
	lineage: HydraRequestLineage,
	params: { hydraHeadId: string; txId: string; consumedInputs: readonly HydraOutputReference[] | null },
): boolean {
	const { hydraHeadId, txId, consumedInputs } = params;
	if (consumedInputs == null) return true;
	const currentTransaction = lineage.CurrentTransaction;
	if (
		currentTransaction?.hydraHeadId === hydraHeadId &&
		(currentTransaction.txHash === txId || currentTransaction.intendedTxHash === txId)
	) {
		return true;
	}
	if (lineage.TransactionHistory.some((history) => history.txHash === txId)) return true;
	return consumedInputs.some((input) => isPersistedHydraOutput(lineage, input));
}

/** Whether an output reference is the exact output the escrow row accepted. */
export function isPersistedHydraOutput(lineage: HydraRequestLineage, outputReference: HydraOutputReference): boolean {
	return (
		lineage.currentHydraUtxoTxHash === outputReference.txHash &&
		lineage.currentHydraUtxoOutputIndex === outputReference.outputIndex
	);
}
