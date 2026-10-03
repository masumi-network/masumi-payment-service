/**
 * Turning a hydra-node `postTxError` into something an operator can act on.
 *
 * When the node refuses to put an L1 transaction on chain it says why, as a
 * tagged union. Discarding that tag makes every refusal look identical — and
 * the fixes are not: `NoSeedInput` means the node's own Cardano key holds
 * nothing and needs funding, while a script or parameter failure means
 * something is genuinely wrong with the head.
 *
 * The mapping covers the tags an operator can do something about and falls
 * back to the raw tag otherwise, because an unrecognised tag is still far more
 * useful than "the node rejected it".
 */

import { getOwnValue, isPlainObject } from '@masumi/payment-core/object-properties';

/** Advice for the tags that have a concrete remedy. */
const EXPLANATIONS: Record<string, string> = {
	NoSeedInput:
		"NoSeedInput: the node's own Cardano key holds no UTxO to seed the head with. Fund the node and try again",
	NotEnoughFuel: "NotEnoughFuel: the node's own Cardano key cannot cover the fee. Fund the node and try again",
	NoFuelUTxOFound: "NoFuelUTxOFound: the node's own Cardano key holds no usable UTxO. Fund the node and try again",
	InternalWalletError: 'InternalWalletError: the node could not build the transaction from the UTxOs it can see',
	ScriptFailedInWallet: 'ScriptFailedInWallet: the transaction failed phase-2 validation before it was submitted',
	FailedToPostTx: 'FailedToPostTx: the chain backend refused the transaction',
	PlutusValidationFailed: 'PlutusValidationFailed: a Hydra script rejected the transaction',
	SavedTxIdMismatch: 'SavedTxIdMismatch: the node built a transaction whose id it did not expect',
};

/**
 * The explanation for a tag, or the tag itself.
 *
 * `EXPLANATIONS[tag]` on a plain object answers for keys nobody put in it: the
 * tag is node-supplied, and `EXPLANATIONS['toString']` is a function, which the
 * `??` does not catch because a function is not nullish. It is returned through
 * a `string` signature, reaches `HydraDecommit.failureReason`, and Prisma
 * refuses to write it — so the refusal is never recorded, the withdrawal stays
 * Pending, and every later withdrawal for that participant is refused because
 * one is "still settling". The same reader runs on the replay path, so it
 * recurs on every reconnect. `__proto__` and `constructor` reach it too.
 */
function explain(tag: string): string {
	const explanation = getOwnValue(EXPLANATIONS, tag);
	return typeof explanation === 'string' ? explanation : tag;
}

/** The `tag` of a hydra-node error object, when it has one. */
export function postTxErrorTag(postTxError: unknown): string | null {
	if (!isPlainObject(postTxError)) {
		return null;
	}
	const tag = getOwnValue(postTxError, 'tag');
	return typeof tag === 'string' && tag.length > 0 && tag.length <= 64 ? tag : null;
}

export function describePostTxError(postTxError: unknown): string {
	const tag = postTxErrorTag(postTxError);
	if (tag === null) {
		return 'no reason given';
	}
	return explain(tag);
}

/**
 * Why the head refused a withdrawal, in whatever shape the node sent it.
 *
 * `DecommitInvalid` carries a free-form reason rather than the tagged union
 * `postTxError` uses: sometimes a tagged object, sometimes a bare string. Both
 * are worth keeping verbatim, because the reason names the ledger rule that was
 * broken and that is the difference between "split the amount differently" and
 * "the counterparty is not cooperating".
 */
export function describeDecommitInvalidReason(reason: unknown): string {
	if (typeof reason === 'string' && reason.length > 0) {
		return reason.slice(0, 2000);
	}
	const tag = postTxErrorTag(reason);
	if (tag !== null) {
		return explain(tag);
	}
	if (isPlainObject(reason)) {
		const nested = getOwnValue(reason, 'reason');
		if (typeof nested === 'string' && nested.length > 0) return nested.slice(0, 2000);
	}
	return 'no reason given';
}

/** Whether this refusal is fixed by putting ADA on the node's key. */
export function isNodeUnfundedError(postTxError: unknown): boolean {
	const tag = postTxErrorTag(postTxError);
	return tag === 'NoSeedInput' || tag === 'NotEnoughFuel' || tag === 'NoFuelUTxOFound';
}
