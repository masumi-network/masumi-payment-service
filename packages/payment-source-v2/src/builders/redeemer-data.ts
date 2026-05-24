// Mesh SDK pinning: this file lives in the V2 package and MUST resolve to the
// V2 mesh line (`@meshsdk/core@1.9.0-beta.102`). The redeemer alternatives are
// fixed by the V2 Aiken validators (smart-contracts/payment-v2/validators/vested_pay.ak
// and smart-contracts/registry-v2/validators/mint.ak) and never depend on the
// mesh version — but the file lives here so the rest of the batch builder
// surface area is uniformly V2-pinned. See docs/adr/0005-meshsdk-version-pinning-v1-v2.md.

/**
 * Redeemer alternative mapping for the V2 payment-escrow validator
 * (`vested_pay.ak`) and adjacent action types.
 *
 * The `Action` enum in vested_pay.ak is:
 *   0 Withdraw
 *   1 SetRefundRequested (RequestRefund)
 *   2 AuthorizeWithdrawal
 *   3 WithdrawRefund (CollectRefund)
 *   4 WithdrawDisputed (not built by mesh: requires admin-signature payload)
 *   5 SubmitResult
 *   6 AuthorizeRefund
 *
 * `CollectCompleted` is the off-chain label for the `Withdraw` redeemer; both
 * resolve to alternative 0.
 *
 * The V1-only `CancelRefund` action is deliberately NOT exposed here — V2's
 * validator (vested_pay.ak `pub type Action`) has no CancelRefund variant.
 * Previously this builder mapped `CancelRefund` to alternative 2 (the same as
 * `AuthorizeWithdrawal`), which would have silently executed a buyer
 * authorize-withdraw on a Disputed UTxO if any V2 caller used the label.
 * Adding a real cancel-refund path requires a contract revision; until then
 * keep V1 callers routed through `src/utils/generator/transaction-generator`.
 */
export function generateRedeemerData(
	type:
		| 'AuthorizeRefund'
		| 'AuthorizeWithdrawal'
		| 'RequestRefund'
		| 'SubmitResult'
		| 'CollectCompleted'
		| 'CollectRefund',
) {
	switch (type) {
		case 'AuthorizeRefund':
			return { alternative: 6, fields: [] };
		case 'AuthorizeWithdrawal':
			return { alternative: 2, fields: [] };
		case 'RequestRefund':
			return { alternative: 1, fields: [] };
		case 'SubmitResult':
			return { alternative: 5, fields: [] };
		case 'CollectCompleted':
			return { alternative: 0, fields: [] };
		case 'CollectRefund':
			return { alternative: 3, fields: [] };
		default: {
			// Compile-time exhaustiveness + runtime guard against bypass via `as any`.
			// Returning `undefined` here previously produced silent CBOR malformation downstream.
			const _exhaustive: never = type;
			throw new Error(`Unsupported V2 redeemer action: ${String(_exhaustive)}`);
		}
	}
}
