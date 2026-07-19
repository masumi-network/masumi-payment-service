export type SubmitResultSubmissionOutcome =
	| {
			status: 'rejected';
			error: unknown;
	  }
	| {
			status: 'submitted';
			txHash: string;
			isRecorded: boolean;
	  };

export async function runSubmitResultSubmissionLifecycle(options: {
	submit: () => Promise<string>;
	requeueRejected: (error: unknown) => Promise<void>;
	evaluateProjectedBalance: () => Promise<void>;
	recordSubmitted: (txHash: string) => Promise<void>;
	onBalanceCheckFailure: (error: unknown, txHash: string) => void;
	onRecordFailure: (error: unknown, txHash: string) => void;
}): Promise<SubmitResultSubmissionOutcome> {
	let txHash: string;
	try {
		txHash = await options.submit();
	} catch (error) {
		await options.requeueRejected(error);
		return { status: 'rejected', error };
	}

	try {
		await options.evaluateProjectedBalance();
	} catch (error) {
		options.onBalanceCheckFailure(error, txHash);
	}

	try {
		await options.recordSubmitted(txHash);
	} catch (error) {
		// The node has already accepted this transaction. Report the database
		// failure, but do not throw into a retry wrapper that would submit again.
		options.onRecordFailure(error, txHash);
		return { status: 'submitted', txHash, isRecorded: false };
	}

	return { status: 'submitted', txHash, isRecorded: true };
}
