import { describe, expect, it } from '@jest/globals';
import { SmartContractState } from '@/utils/generator/contract-generator';
import { isRequestedResultOnChain } from './result-on-chain';

describe('isRequestedResultOnChain', () => {
	const RESULT_HASH = 'ab'.repeat(32);
	const onChain = (state: SmartContractState, resultHash: string | null = RESULT_HASH) => ({ state, resultHash });

	// A rejected result that the head confirms later leaves the request asking
	// for a result the escrow already holds, and building it again pays for a
	// second identical SubmitResult.
	it.each([
		['a submitted result', SmartContractState.ResultSubmitted],
		['a disputed result', SmartContractState.Disputed],
	])('is true when the escrow already holds the requested result as %s', (_label, state) => {
		expect(isRequestedResultOnChain(onChain(state), RESULT_HASH)).toBe(true);
	});

	it('ignores the case of the hash', () => {
		expect(isRequestedResultOnChain(onChain(SmartContractState.ResultSubmitted), RESULT_HASH.toUpperCase())).toBe(true);
	});

	// Rotating to a new result during the dispute window is a real submit.
	it('is false when the escrow holds a different result', () => {
		expect(isRequestedResultOnChain(onChain(SmartContractState.ResultSubmitted, 'cd'.repeat(32)), RESULT_HASH)).toBe(
			false,
		);
	});

	it.each([
		['FundsLocked', SmartContractState.FundsLocked],
		['RefundRequested', SmartContractState.RefundRequested],
	])('is false while the escrow is %s, whatever hash it carries', (_label, state) => {
		expect(isRequestedResultOnChain(onChain(state), RESULT_HASH)).toBe(false);
	});

	it.each([
		['the request has none', onChain(SmartContractState.ResultSubmitted), null],
		['the escrow has none', onChain(SmartContractState.ResultSubmitted, null), RESULT_HASH],
	])('is false when %s', (_label, decoded, requested) => {
		expect(isRequestedResultOnChain(decoded, requested)).toBe(false);
	});
});
