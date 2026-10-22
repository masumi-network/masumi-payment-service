import { DecodedV1ContractDatum } from '@/utils/converter/string-datum-convert';

/**
 * The SubmitResult validity-window rules: which on-chain deadline bounds the
 * tx, and the typed error for a request whose window has closed for good.
 */

// Slack kept off each on-chain SubmitResult deadline. The default tx-window
// invalidAfter is ~now+2.5min+buffer; keeping ≥5min off the bound ensures a
// submission never races the ledger boundary (a tx whose invalidAfter lands
// after the bound is rejected by `must_end_before`).
export const SUBMIT_RESULT_WINDOW_SLACK_MS = 1000 * 60 * 5;

/**
 * Pick the `constrainAfterMs` (upper-bound anchor) for the SubmitResult tx
 * validity window, matching the two legal time windows in vested_pay.ak's
 * `SubmitResult` redeemer:
 *
 *   A) Normal: tx must end before `submit_result_time`. Used while that deadline
 *      is still comfortably ahead.
 *   B) Dispute-window rotation: once past `submit_result_time`, the validator
 *      still accepts a re-submit as long as the tx ends before
 *      `external_dispute_unlock_time` AND the CURRENT on-chain datum already
 *      carries a result (`result_hash` non-empty — true for ResultSubmitted /
 *      Disputed). Anchor invalidAfter to `external_dispute_unlock_time` so the
 *      window is in the future. (The old code anchored unconditionally to
 *      `submit_result_time`; once that was in the past, createTxWindow's `min`
 *      strategy produced invalidAfter < invalidBefore — an unbuildable tx — so
 *      the dispute-rotation capability was dead off-chain.)
 *
 * Throws a terminal (non-deferred) error when neither window is open so the
 * caller marks the row for manual action rather than re-queueing it forever.
 */
export function resolveSubmitResultConstrainAfterMs(decodedContract: DecodedV1ContractDatum, nowMs: number): bigint {
	const cutoff = BigInt(nowMs + SUBMIT_RESULT_WINDOW_SLACK_MS);
	if (decodedContract.resultTime > cutoff) {
		return decodedContract.resultTime;
	}
	if (decodedContract.resultHash != null && decodedContract.externalDisputeUnlockTime > cutoff) {
		return decodedContract.externalDisputeUnlockTime;
	}
	throw new SubmitResultWindowClosedError(
		decodedContract.resultHash == null
			? 'SubmitResult window closed: past submit_result_time and no on-chain result to rotate during the dispute window; manual intervention required'
			: 'SubmitResult window closed: past both submit_result_time and external_dispute_unlock_time; manual intervention required',
	);
}

/**
 * The deadline has passed, so no retry can succeed.
 *
 * Typed because the difference matters to the caller. An ordinary failure is
 * worth retrying — a busy wallet, a slow node — and the request is left where
 * the next pass will pick it up. This one never becomes possible again, and a
 * pass that takes one request per wallet then picks the same doomed request
 * every round: the queue behind it starves while its own deadlines expire, one
 * expiry cascading into the next.
 */
export class SubmitResultWindowClosedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SubmitResultWindowClosedError';
	}
}
