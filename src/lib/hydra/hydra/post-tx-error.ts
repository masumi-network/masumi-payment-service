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
	return EXPLANATIONS[tag] ?? tag;
}

/** Whether this refusal is fixed by putting ADA on the node's key. */
export function isNodeUnfundedError(postTxError: unknown): boolean {
	const tag = postTxErrorTag(postTxError);
	return tag === 'NoSeedInput' || tag === 'NotEnoughFuel' || tag === 'NoFuelUTxOFound';
}
