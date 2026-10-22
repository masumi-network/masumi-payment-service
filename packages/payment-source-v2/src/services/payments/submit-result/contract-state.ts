import { SmartContractState } from '@/utils/generator/contract-generator';
import { LOOKUP_DEFERRED_PREFIX } from '../../lookup-defer';

/**
 * Determine the new contract state for a SubmitResult transition.
 *
 * vested_pay.ak only permits SubmitResult from `FundsLocked`, `RefundRequested`,
 * `ResultSubmitted` (re-submit), or `Disputed` — see the validator's
 * SubmitResult branch. From `WithdrawAuthorized` / `RefundAuthorized` the
 * transition is rejected on chain, and from terminal-derived states the
 * UTxO has already been consumed.
 *
 * If tx-sync ever leaves a request row with `paymentStatus=SubmitResultRequested`
 * but the on-chain datum already advanced to an unrejected state, building the
 * batch tx with that item would phase-2-fail the WHOLE batch. Surface the
 * defer-sentinel here so the caller's catch arm routes the item to the queue
 * via the `info`-level defer log instead of marking it failed and dragging the
 * batch down.
 */
export function determineNewContractState(currentState: SmartContractState): SmartContractState {
	switch (currentState) {
		case SmartContractState.Disputed:
		case SmartContractState.RefundRequested:
			return SmartContractState.Disputed;
		case SmartContractState.FundsLocked:
		case SmartContractState.ResultSubmitted:
			return SmartContractState.ResultSubmitted;
		case SmartContractState.WithdrawAuthorized:
		case SmartContractState.RefundAuthorized:
			throw new Error(
				`${LOOKUP_DEFERRED_PREFIX} SubmitResult not legal from on-chain state ${currentState} — request is stale, deferring to next tick`,
			);
		default: {
			// Exhaustiveness: a future SmartContractState added without updating this
			// switch should fail loudly rather than silently emit ResultSubmitted.
			const _exhaustive: never = currentState;
			throw new Error(
				`${LOOKUP_DEFERRED_PREFIX} SubmitResult: unknown on-chain state ${String(_exhaustive)} — deferring`,
			);
		}
	}
}
