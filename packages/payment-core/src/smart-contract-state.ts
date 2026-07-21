import { OnChainState } from '@prisma/client';

export enum SmartContractState {
	FundsLocked = 0,
	ResultSubmitted = 1,
	RefundRequested = 2,
	Disputed = 3,
	WithdrawAuthorized = 4,
	RefundAuthorized = 5,
}

export function smartContractStateEqualsOnChainState(state: SmartContractState, onChainState: OnChainState | null) {
	if (onChainState == null) {
		return false;
	}
	switch (onChainState) {
		case OnChainState.FundsLocked:
			return state == SmartContractState.FundsLocked;
		case OnChainState.ResultSubmitted:
			return state == SmartContractState.ResultSubmitted;
		case OnChainState.RefundRequested:
			return state == SmartContractState.RefundRequested;
		case OnChainState.Disputed:
			return state == SmartContractState.Disputed;
		case OnChainState.WithdrawAuthorized:
			return state == SmartContractState.WithdrawAuthorized;
		case OnChainState.RefundAuthorized:
			return state == SmartContractState.RefundAuthorized;
		default:
			return false;
	}
}

/**
 * Maps an on-chain datum state to the database's OnChainState.
 *
 * The inverse of `smartContractStateEqualsOnChainState`, needed wherever the
 * chain is the source of truth and the database has to be brought to it —
 * notably the manual repair path, where an operator supplies a transaction and
 * the state is derived from its datum rather than typed in by hand.
 */
export function onChainStateFromSmartContractState(state: SmartContractState): OnChainState {
	switch (state) {
		case SmartContractState.FundsLocked:
			return OnChainState.FundsLocked;
		case SmartContractState.ResultSubmitted:
			return OnChainState.ResultSubmitted;
		case SmartContractState.RefundRequested:
			return OnChainState.RefundRequested;
		case SmartContractState.Disputed:
			return OnChainState.Disputed;
		case SmartContractState.WithdrawAuthorized:
			return OnChainState.WithdrawAuthorized;
		case SmartContractState.RefundAuthorized:
			return OnChainState.RefundAuthorized;
	}
}
