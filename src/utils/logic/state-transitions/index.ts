import {
	OnChainState,
	PaymentAction,
	PaymentErrorType,
	PurchaseErrorType,
	PurchasingAction,
} from '@/generated/prisma/client';
import { ActionTransitions, paymentTransitions, purchasingTransitions, TransitionOutcome } from './transition-tables';

/**
 * Data-driven replacement for the former switch-tree implementation. Given the
 * action a request is currently performing and the newly observed on-chain
 * state, the tables in `transition-tables.ts` decide which action the request
 * moves to and whether the change is reported as an error.
 *
 * Behavior is characterization-locked by `transition-matrix.fixture.json`
 * (see index.spec.ts) — every (action × state) combination is pinned.
 */
function lookup<TAction extends string>(
	table: Record<TAction, ActionTransitions<TAction>>,
	currentAction: TAction,
	newState: OnChainState,
): TransitionOutcome<TAction> {
	const row = table[currentAction];
	return row.byState?.[newState] ?? row.default;
}

export function convertNewPurchasingActionAndError(
	currentAction: PurchasingAction,
	newState: OnChainState,
): {
	action: PurchasingAction;
	errorNote: string | null;
	errorType: PurchaseErrorType | null;
} {
	const outcome = lookup(purchasingTransitions, currentAction, newState);
	return {
		action: outcome.action,
		errorNote: outcome.errorNote ?? null,
		errorType: outcome.errorNote != null ? PurchaseErrorType.Unknown : null,
	};
}

export function convertNewPaymentActionAndError(
	currentAction: PaymentAction,
	newState: OnChainState,
): {
	action: PaymentAction;
	errorNote: string | null;
	errorType: PaymentErrorType | null;
} {
	const outcome = lookup(paymentTransitions, currentAction, newState);
	return {
		action: outcome.action,
		errorNote: outcome.errorNote ?? null,
		errorType: outcome.errorNote != null ? PaymentErrorType.Unknown : null,
	};
}
