import { generateRedeemerData } from '../redeemer-data';

describe('generateRedeemerData', () => {
	// The alternative numbers below MUST match the Aiken `Action` enum in
	// smart-contracts/payment-v2/validators/vested_pay.ak. Any change here
	// without a matching contract redeploy will brick on-chain interactions.
	it('maps Withdraw / CollectCompleted to alternative 0', () => {
		expect(generateRedeemerData('CollectCompleted')).toEqual({ alternative: 0, fields: [] });
	});

	it('maps RequestRefund to alternative 1', () => {
		expect(generateRedeemerData('RequestRefund')).toEqual({ alternative: 1, fields: [] });
	});

	it('maps AuthorizeWithdrawal to alternative 2', () => {
		expect(generateRedeemerData('AuthorizeWithdrawal')).toEqual({ alternative: 2, fields: [] });
	});

	it('does NOT accept CancelRefund — V2 validator has no such action', () => {
		// Static guard: `@ts-expect-error` asserts the type union excludes CancelRefund —
		// if someone re-adds the label, this directive starts failing and forces a review
		// of vested_pay.ak. Runtime guard: a caller bypassing the type with `as any` must
		// not silently get `undefined` (which would malform downstream CBOR); the default
		// branch in generateRedeemerData throws instead.
		expect(() =>
			// @ts-expect-error CancelRefund is not part of the V2 redeemer union.
			generateRedeemerData('CancelRefund'),
		).toThrow(/Unsupported V2 redeemer action/);
	});

	it('maps CollectRefund to alternative 3', () => {
		expect(generateRedeemerData('CollectRefund')).toEqual({ alternative: 3, fields: [] });
	});

	it('maps SubmitResult to alternative 5', () => {
		expect(generateRedeemerData('SubmitResult')).toEqual({ alternative: 5, fields: [] });
	});

	it('maps AuthorizeRefund to alternative 6', () => {
		expect(generateRedeemerData('AuthorizeRefund')).toEqual({ alternative: 6, fields: [] });
	});

	it('returns an empty fields array for every action (all V2 actions are nullary)', () => {
		const all = [
			'AuthorizeRefund',
			'AuthorizeWithdrawal',
			'RequestRefund',
			'SubmitResult',
			'CollectCompleted',
			'CollectRefund',
		] as const;
		for (const action of all) {
			expect(generateRedeemerData(action).fields).toEqual([]);
		}
	});

	it('does NOT emit alternative 4 — that is the admin-signed WithdrawDisputed redeemer which mesh does not build', () => {
		// Sanity check: WithdrawDisputed requires an admin-signature payload
		// and is built by the admin-only builder, not by `generateRedeemerData`.
		// If a future contract change adds it here, the admin builder will
		// produce ambiguous tx encodings.
		const all = [
			'AuthorizeRefund',
			'AuthorizeWithdrawal',
			'RequestRefund',
			'SubmitResult',
			'CollectCompleted',
			'CollectRefund',
		] as const;
		for (const action of all) {
			expect(generateRedeemerData(action).alternative).not.toBe(4);
		}
	});
});
