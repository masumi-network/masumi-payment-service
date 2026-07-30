import { OnChainState } from '@prisma/client';
import {
	SmartContractState,
	onChainStateFromSmartContractState,
	smartContractStateEqualsOnChainState,
} from './smart-contract-state';

describe('onChainStateFromSmartContractState', () => {
	it.each([
		[SmartContractState.FundsLocked, OnChainState.FundsLocked],
		[SmartContractState.ResultSubmitted, OnChainState.ResultSubmitted],
		[SmartContractState.RefundRequested, OnChainState.RefundRequested],
		[SmartContractState.Disputed, OnChainState.Disputed],
		[SmartContractState.WithdrawAuthorized, OnChainState.WithdrawAuthorized],
		[SmartContractState.RefundAuthorized, OnChainState.RefundAuthorized],
	])('maps %p to %p', (state, expected) => {
		expect(onChainStateFromSmartContractState(state)).toBe(expected);
	});

	// The two functions must agree, or the repair path would write a state the
	// rest of the system does not consider a match for the same datum.
	it.each([
		SmartContractState.FundsLocked,
		SmartContractState.ResultSubmitted,
		SmartContractState.RefundRequested,
		SmartContractState.Disputed,
		SmartContractState.WithdrawAuthorized,
		SmartContractState.RefundAuthorized,
	])('round-trips with smartContractStateEqualsOnChainState for %p', (state) => {
		expect(smartContractStateEqualsOnChainState(state, onChainStateFromSmartContractState(state))).toBe(true);
	});
});
