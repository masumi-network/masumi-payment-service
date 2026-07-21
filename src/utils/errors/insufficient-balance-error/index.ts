import { errorToString } from '@/utils/converter/error-string-convert';

/**
 * Recognises a Mesh coin-selection failure — the tx could not be balanced from
 * the candidate inputs it was given.
 *
 * Pure string matching on purpose: Mesh throws plain `Error`s from several
 * layers (`InputSelectionError`, the balancer, the min-UTxO check) with no
 * shared class or code to switch on.
 *
 * Used to decide whether holding the collateral UTxO back from coin selection
 * made a transaction unbuildable, in which case the caller retries with the
 * collateral available. This must stay narrow: a false positive would retry a
 * genuinely broken build and mask the real error.
 */
export function isInsufficientBalanceBuildError(error: unknown): boolean {
	const message = errorToString(error).toLowerCase();
	return (
		message.includes('utxo fully depleted') ||
		message.includes('inputselectionerror') ||
		message.includes('insufficient balance') ||
		message.includes('utxo balance insufficient') ||
		message.includes('not enough ada') ||
		message.includes('not enough lovelace')
	);
}
