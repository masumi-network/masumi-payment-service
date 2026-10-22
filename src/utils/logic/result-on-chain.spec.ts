import { describe, expect, it } from '@jest/globals';
import { SmartContractState } from '@/utils/generator/contract-generator';
import { OnChainState, PaymentAction } from '@/generated/prisma/client';
import { convertSyncedPaymentAction, isRequestedResultOnChain } from './result-on-chain';

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

describe('convertSyncedPaymentAction', () => {
	const RESULT_HASH = 'ab'.repeat(32);
	const OTHER_HASH = 'cd'.repeat(32);

	// A submit that was refused or threw, then confirmed: the request is back at
	// SubmitResultRequested, and leaving it there strands it with no hash.
	it.each([OnChainState.ResultSubmitted, OnChainState.Disputed])(
		'settles a request whose result is already on chain at %s',
		(state) => {
			expect(
				convertSyncedPaymentAction(PaymentAction.SubmitResultRequested, RESULT_HASH, state, RESULT_HASH.toUpperCase()),
			).toEqual({
				action: PaymentAction.WaitingForExternalAction,
				errorNote: null,
				errorType: null,
				resultHash: undefined,
			});
		},
	);

	// The submit passes select only requests that carry a hash.
	it.each([
		['a different result is on chain', OnChainState.ResultSubmitted, OTHER_HASH],
		['the buyer requested a refund', OnChainState.RefundRequested, null],
	])('keeps the pending hash when %s', (_label, state, onChainHash) => {
		expect(
			convertSyncedPaymentAction(PaymentAction.SubmitResultRequested, RESULT_HASH, state, onChainHash),
		).toMatchObject({ action: PaymentAction.SubmitResultRequested, resultHash: RESULT_HASH });
	});

	// The buyer's refund request spent the output an in-flight submit was built
	// on, so the table requeues the submit and it must keep the result to resend.
	it('keeps the in-flight hash when a refund request lands first', () => {
		expect(
			convertSyncedPaymentAction(PaymentAction.SubmitResultInitiated, RESULT_HASH, OnChainState.RefundRequested, null),
		).toMatchObject({ action: PaymentAction.SubmitResultRequested, resultHash: RESULT_HASH });
	});

	it('parks a request whose escrow was withdrawn, without a hash', () => {
		expect(
			convertSyncedPaymentAction(PaymentAction.SubmitResultRequested, RESULT_HASH, OnChainState.Withdrawn, null),
		).toMatchObject({ action: PaymentAction.WaitingForManualAction, resultHash: undefined });
	});
});
