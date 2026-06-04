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
 * Reused by:
 *   - `purchases/batch-payments/service.ts` (V2 funding txs)
 *   - `wallet-collateral/ensure-collateral-ready.ts` (V2 collateral prep)
 */
export function isDefinitiveNodeRejection(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const msg = error.message ?? '';
	return /BadInputsUTxO|OutsideValidityIntervalUTxO|InsufficientCollateral|FeeTooSmall|ScriptWitnessNotValidatingUTXOW|ValueNotConservedUTxO|MissingScriptWitnessesUTXOW|MissingVKeyWitnessesUTXOW/.test(
		msg,
	);
}
