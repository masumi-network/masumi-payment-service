import { interpretBlockchainError } from '@masumi/payment-core/blockchain-error-interpreter';
import { isDefinitiveNodeRejection } from '@masumi/payment-core/submit-error-classifier';
import { resolveTxHash } from '@meshsdk/core';

export type AmbiguousRegistrySubmit = {
	intendedTxHash: string;
	failure: Error;
};

/**
 * Tells a registry submit failure that reached the chain apart from one that
 * did not, and returns the operator-facing description for the ambiguous case.
 *
 * Returns null when the node definitively rejected the transaction before
 * broadcast. Nothing reached the chain, so the plain failure is the whole
 * truth and the caller stamps the original error.
 *
 * Returns a description when the failure proves nothing: a transport error, a
 * 5xx, a timeout. The transaction may be on chain. The payment paths hand that
 * case to funding-reconciliation, but the single-item registry paths submit
 * before they write, so there is no pending Transaction row to reconcile.
 * Reverting the request to its `*Requested` state is not the safe answer
 * either: the next tick rebuilds against chain state that may already have
 * moved, and that rebuild then fails for a reason that hides the real one. The
 * caller fails the request terminally and stores this text, which names the
 * hash an operator has to look up before retrying.
 */
export function describeAmbiguousRegistrySubmit(signedTx: string, error: unknown): AmbiguousRegistrySubmit | null {
	if (isDefinitiveNodeRejection(error)) {
		return null;
	}
	const intendedTxHash = String(resolveTxHash(signedTx));
	return {
		intendedTxHash,
		failure: new Error(
			`Submission failed without a node rejection, so the transaction may still be on chain. ` +
				`Check ${intendedTxHash} before retrying. Cause: ${interpretBlockchainError(error)}`,
		),
	};
}
