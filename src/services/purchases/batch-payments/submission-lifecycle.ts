export type BuiltBatchTransaction = {
	completeTx: string;
	signedTx: string;
	resolvedTxHash: string;
	invalidHereafterSlot: number;
};

export type BatchSubmissionLifecycleResult =
	| ({ status: 'submitted'; submittedTxHash: string } & BuiltBatchTransaction)
	| ({ status: 'ambiguous'; error: unknown } & BuiltBatchTransaction)
	| ({ status: 'divergent'; submittedTxHash: string } & BuiltBatchTransaction);

/**
 * Enforces the safety-critical batch ordering:
 * build/sign -> persist deterministic identity and expiry -> submit exactly once.
 *
 * Submission errors are returned as ambiguous because the node may have accepted
 * the transaction before the transport failed. Callers must retain the wallet
 * lock and persisted transaction until reconciliation proves the transaction
 * expired or finds it on-chain.
 */
export async function runBatchSubmissionLifecycle({
	buildAndSign,
	persistBeforeSubmit,
	submit,
}: {
	buildAndSign: () => Promise<BuiltBatchTransaction>;
	persistBeforeSubmit: (transaction: BuiltBatchTransaction) => Promise<void>;
	submit: (signedTx: string) => Promise<string>;
}): Promise<BatchSubmissionLifecycleResult> {
	const transaction = await buildAndSign();
	await persistBeforeSubmit(transaction);

	let submittedTxHash: string;
	try {
		submittedTxHash = await submit(transaction.signedTx);
	} catch (error) {
		return { status: 'ambiguous', ...transaction, error };
	}

	if (submittedTxHash !== transaction.resolvedTxHash) {
		return { status: 'divergent', ...transaction, submittedTxHash };
	}

	return { status: 'submitted', ...transaction, submittedTxHash };
}
