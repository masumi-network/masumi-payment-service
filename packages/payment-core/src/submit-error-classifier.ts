/**
 * Classify a `submitTx` exception as definitive node rejection vs ambiguous
 * network/transport failure.
 *
 * - "Definitive": the node returned a ledger-side validation rejection
 *   BEFORE broadcasting. Safe to revert request state / mark RolledBack.
 *
 * - "Ambiguous": the throw doesn't prove the tx didn't land (HTTP 5xx,
 *   fetch errors, ECONNRESET, blockfrost timeouts, gateway 504). The tx
 *   MAY be on chain. Reverting state risks double-spend / double-lock /
 *   wasted ex-units burn. Leave the row Pending and let the
 *   `funding-reconciliation` worker resolve via chain query.
 *
 * Conservative whitelist: only patterns we've proven to mean pre-broadcast
 * node rejection are treated as definitive. Anything not on the list is
 * ambiguous. Extending this list reintroduces the double-action window if
 * a false-positive is added — verify against actual Mesh/Blockfrost output
 * in your environment first.
 *
 * NOTE on error shape: Mesh wraps a Blockfrost 4xx as a PLAIN OBJECT
 * (`{ data: { message: "...ValidationTagMismatch..." }, status: 400 }`), not
 * an `Error` instance, and buries the ledger detail under `data.message`.
 * We therefore walk the whole error structure rather than reading
 * `error.message` alone — otherwise a definitive Plutus phase-2 failure is
 * mis-classified as ambiguous, leaving the wallet locked and the row Pending
 * until `funding-reconciliation` gives up at the invalidHereafterSlot TTL.
 *
 * Reused by:
 *   - `purchases/batch-payments/service.ts` (V2 funding txs)
 *   - `payments/submit-result/service.ts` (V2 result submission)
 *   - `wallet-collateral/ensure-collateral-ready.ts` (V2 collateral prep)
 */
const DEFINITIVE_REJECTION_PATTERN =
	/BadInputsUTxO|OutsideValidityIntervalUTxO|InsufficientCollateral|FeeTooSmall|ScriptWitnessNotValidatingUTXOW|ValueNotConservedUTxO|MissingScriptWitnessesUTXOW|MissingVKeyWitnessesUTXOW|ValidationTagMismatch|PlutusFailure/;

export function isDefinitiveNodeRejection(error: unknown): boolean {
	return DEFINITIVE_REJECTION_PATTERN.test(collectErrorText(error));
}

/**
 * Collect every plausible message string reachable from an error value. Handles
 * raw strings, `Error` instances (whose `message` is non-enumerable), and the
 * nested plain-object shape Mesh/Blockfrost throws. Cycle- and depth-guarded.
 */
// Named shape (NOT a string-keyed map) so we satisfy the no-unknown-valued-maps
// rule while still reaching the fields Mesh/Blockfrost bury the ledger detail
// under. Direct `.message` access also captures `Error.message` (non-enumerable
// but still readable), so Error instances need no special case.
interface ErrorLike {
	message?: unknown;
	error?: unknown;
	data?: unknown;
	body?: unknown;
	response?: unknown;
	cause?: unknown;
	reason?: unknown;
}

function collectErrorText(error: unknown): string {
	const parts: string[] = [];
	const seen = new Set<unknown>();
	const visit = (value: unknown, depth: number): void => {
		if (value == null || depth > 5) return;
		if (typeof value === 'string') {
			parts.push(value);
			return;
		}
		if (typeof value !== 'object' || seen.has(value)) return;
		seen.add(value);
		const e = value as ErrorLike;
		visit(e.message, depth + 1);
		visit(e.error, depth + 1);
		visit(e.data, depth + 1);
		visit(e.body, depth + 1);
		visit(e.response, depth + 1);
		visit(e.cause, depth + 1);
		visit(e.reason, depth + 1);
	};
	visit(error, 0);
	return parts.join('\n');
}
