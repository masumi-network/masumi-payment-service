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

	// ---------------------------------------------------------------------
	// Canonical CBOR encoding invariant for the WithdrawDisputed (alt 4)
	// redeemer payload.
	//
	// The Aiken validator (smart-contracts/payment-v2/validators/vested_pay.ak)
	// hashes the `DisputeWithdrawal { own_ref, buyer_value, seller_value }`
	// payload via `cbor.serialise |> blake2b_224` on-chain. The `AssetValue`
	// field is a Plutus map keyed by policy ID, whose entries are inner maps
	// keyed by asset name. Cardano deterministic CBOR rules require these
	// maps to be encoded with keys in canonical (lexicographic) order. Two
	// payloads with the same logical assets but different map key orderings
	// produce different CBOR bytes, different blake2b_224 hashes, and
	// therefore non-matching admin signatures.
	//
	// Off-chain helpers MUST canonicalize the AssetValue map before signing
	// and before submitting the redeemer. The reference helper
	// `assetsToAssetValueData` in
	// smart-contracts/payment-v2/example-helpers.mjs performs the required
	// `localeCompare` sort on policy IDs and asset names, and the V2 README
	// (smart-contracts/payment-v2/README.md, "Admin signing runbook")
	// documents that deterministic CBOR encoding is mandatory.
	//
	// `generateRedeemerData` intentionally does NOT construct alt 4 (see
	// the test above), so there is no per-call AssetValue encoding path to
	// exercise here. The regression assertion below pins that fact: if alt 4
	// is ever surfaced through this module without an explicit canonical
	// AssetValue sort, the test must fail so the admin signing flow is
	// re-reviewed against the on-chain CBOR invariant.
	// ---------------------------------------------------------------------
	it('refuses to build the WithdrawDisputed (alt 4) redeemer — admin AssetValue payload must be canonicalised by the dedicated admin builder', () => {
		// All nullary mesh-built actions must continue to bypass alt 4.
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
			expect(generateRedeemerData(action).alternative).not.toBe(4);
		}

		// Attempting to coerce a non-canonical AssetValue payload through the
		// mesh-built path (e.g. passing a synthetic 'WithdrawDisputed' label
		// or a buyer/seller AssetValue Pairs list sorted in descending policy
		// order) MUST fail loudly rather than silently producing a redeemer
		// the on-chain validator cannot verify against admin signatures.
		expect(() =>
			// @ts-expect-error WithdrawDisputed is intentionally not part of the
			// mesh-built V2 redeemer union; the admin-only builder owns it.
			generateRedeemerData('WithdrawDisputed'),
		).toThrow(/Unsupported V2 redeemer action/);
	});
});
