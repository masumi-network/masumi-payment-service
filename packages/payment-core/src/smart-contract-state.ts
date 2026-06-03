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
