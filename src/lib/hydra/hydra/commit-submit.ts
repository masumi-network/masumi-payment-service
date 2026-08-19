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
const MAX_FAILURE_REASON_LENGTH = 512;
const SENSITIVE_FAILURE_KEY = /(?:cbor|transaction|witness|secret|mnemonic|private|signing.?key)/i;

export function interpretCardanoTxSubmitResult(result: unknown): CardanoTxSubmitResult {
	if (result && typeof result === 'object' && 'tag' in result && (result as { tag: unknown }).tag === SUCCESS_TAG) {
		return { ok: true };
	}

	const reason =
		result && typeof result === 'object' && 'failureReason' in result
			? stringifyReason((result as { failureReason: unknown }).failureReason)
			: stringifyReason(result);
	return { ok: false, reason };
}

/**
 * The hydra-node's `failureReason` is normally a string, but fall back to a
 * JSON serialization for structured reasons so the message never degrades to
 * the useless `"[object Object]"`.
 */
function stringifyReason(reason: unknown): string {
	if (typeof reason === 'string') {
		return sanitizeReasonText(reason);
	}
	try {
		const serialized = JSON.stringify(reason, (key, value: unknown) =>
			key && SENSITIVE_FAILURE_KEY.test(key) ? '[redacted]' : value,
		);
		return sanitizeReasonText(serialized ?? String(reason));
	} catch {
		return sanitizeReasonText(String(reason));
	}
}

function sanitizeReasonText(reason: string): string {
	const withoutLongHex = reason.replace(/[0-9a-fA-F]{128,}/g, '[redacted hex]');
	return withoutLongHex.length <= MAX_FAILURE_REASON_LENGTH
		? withoutLongHex
		: `${withoutLongHex.slice(0, MAX_FAILURE_REASON_LENGTH - 1)}…`;
}
