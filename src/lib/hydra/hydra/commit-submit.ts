/**
 * Interpretation of the hydra-node `POST /cardano-transaction` submit response.
 *
 * The node relays a signed L1 transaction (e.g. a commit / deposit tx) to the
 * exact L1 the head lives on and replies with a tagged object:
 *   - `{ tag: 'TransactionSubmitted' }`                       → accepted by L1
 *   - `{ tag: 'FailedToPostTx', failureReason, failingTx }`   → rejected by L1
 *
 * Submitting the commit through the node (rather than a wallet's L1 provider
 * such as Blockfrost) is what makes a real commit work in every environment —
 * including a local devnet whose network magic Blockfrost cannot see. This
 * helper normalises the node's reply so callers can fail loudly when the commit
 * never reached L1 instead of silently assuming success.
 */
export type CardanoTxSubmitResult = { ok: true } | { ok: false; reason: string };

const SUCCESS_TAG = 'TransactionSubmitted';

export function interpretCardanoTxSubmitResult(result: unknown): CardanoTxSubmitResult {
	// Only an explicit non-success tag is treated as a failure. The node always
	// returns a tagged object for this endpoint; a tagless / non-object reply is
	// treated as success to preserve the original handler's behaviour (the node
	// contract guarantees a tag, so that branch is purely defensive).
	if (result && typeof result === 'object' && 'tag' in result && (result as { tag: unknown }).tag !== SUCCESS_TAG) {
		const reason =
			'failureReason' in result
				? stringifyReason((result as { failureReason: unknown }).failureReason)
				: JSON.stringify(result);
		return { ok: false, reason };
	}

	return { ok: true };
}

/**
 * The hydra-node's `failureReason` is normally a string, but fall back to a
 * JSON serialization for structured reasons so the message never degrades to
 * the useless `"[object Object]"`.
 */
function stringifyReason(reason: unknown): string {
	if (typeof reason === 'string') {
		return reason;
	}
	try {
		return JSON.stringify(reason);
	} catch {
		return String(reason);
	}
}
