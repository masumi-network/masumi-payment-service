import { OnChainState, PaymentSourceType } from '@/generated/prisma/client';
import { SmartContractState } from '@/utils/generator/contract-generator';
import { checkPaymentAmountsMatch, getCardanoFeesBuyer, getCardanoFeesSeller, redeemerToOnChainState } from './index';

const V1 = PaymentSourceType.Web3CardanoV1;
const V2 = PaymentSourceType.Web3CardanoV2;

describe('getCardanoFeesSeller', () => {
	// Redeemer alts mirror the Aiken `Action` enum in both
	// smart-contracts/payment/validators/vested_pay.ak (V1) and
	// smart-contracts/payment-v2/validators/vested_pay.ak (V2).
	it('attributes the share to seller for Withdraw (0) on V1 and V2', () => {
		expect(getCardanoFeesSeller(0, 1_000_000n, V1)).toBe(1_000_000n);
		expect(getCardanoFeesSeller(0, 1_000_000n, V2)).toBe(1_000_000n);
	});

	it('attributes the share to seller for SubmitResult (5) on V1 and V2', () => {
		expect(getCardanoFeesSeller(5, 1_000_000n, V1)).toBe(1_000_000n);
		expect(getCardanoFeesSeller(5, 1_000_000n, V2)).toBe(1_000_000n);
	});

	it('attributes the share to seller for AuthorizeRefund (6) on V1 and V2', () => {
		// AuthorizeRefund is the seller cooperating with a disputed refund —
		// fee is the seller's responsibility in both contract versions.
		expect(getCardanoFeesSeller(6, 1_000_000n, V1)).toBe(1_000_000n);
		expect(getCardanoFeesSeller(6, 1_000_000n, V2)).toBe(1_000_000n);
	});

	it('attributes 0 to seller for alt 2 on both source types (buyer-paid)', () => {
		// V1 alt 2 = CancelRefund (buyer-signed). V2 alt 2 = AuthorizeWithdrawal
		// (also buyer-signed; see smart-contracts/payment-v2/validators/
		// vested_pay.ak:491-492 `must_be_signed_by(buyer_vk)`). Both flows are
		// driven from the purchases/ services so the buyer's hot wallet
		// supplies the inputs and pays the on-chain fee.
		expect(getCardanoFeesSeller(2, 1_000_000n, V1)).toBe(0n);
		expect(getCardanoFeesSeller(2, 1_000_000n, V2)).toBe(0n);
	});

	it('attributes 0 to seller for buyer-side and admin redeemers', () => {
		// 1 RequestRefund (buyer), 2 CancelRefund/AuthorizeWithdrawal (buyer),
		// 3 WithdrawRefund (buyer), 4 WithdrawDisputed (admin — admin wallet
		// pays, neither party is debited).
		for (const otherRedeemer of [1, 2, 3, 4]) {
			expect(getCardanoFeesSeller(otherRedeemer, 1_000_000n, V1)).toBe(0n);
			expect(getCardanoFeesSeller(otherRedeemer, 1_000_000n, V2)).toBe(0n);
		}
	});

	it('attributes 0 to seller for unknown redeemer versions', () => {
		expect(getCardanoFeesSeller(99, 1_000_000n, V1)).toBe(0n);
		expect(getCardanoFeesSeller(99, 1_000_000n, V2)).toBe(0n);
	});

	it('handles zero share without dividing', () => {
		expect(getCardanoFeesSeller(0, 0n, V1)).toBe(0n);
	});
});

describe('getCardanoFeesBuyer', () => {
	it('attributes the share to buyer for RequestRefund (1) on V1 and V2', () => {
		expect(getCardanoFeesBuyer(1, 1_000_000n, V1)).toBe(1_000_000n);
		expect(getCardanoFeesBuyer(1, 1_000_000n, V2)).toBe(1_000_000n);
	});

	it('attributes the share to buyer for alt 2 on both source types', () => {
		// V1 alt 2 = CancelRefund (buyer-signed). V2 alt 2 = AuthorizeWithdrawal
		// (also buyer-signed; see smart-contracts/payment-v2/validators/
		// vested_pay.ak:491-492 `must_be_signed_by(buyer_vk)`).
		expect(getCardanoFeesBuyer(2, 1_000_000n, V1)).toBe(1_000_000n);
		expect(getCardanoFeesBuyer(2, 1_000_000n, V2)).toBe(1_000_000n);
	});

	it('attributes the share to buyer for WithdrawRefund (3) on V1 and V2', () => {
		expect(getCardanoFeesBuyer(3, 1_000_000n, V1)).toBe(1_000_000n);
		expect(getCardanoFeesBuyer(3, 1_000_000n, V2)).toBe(1_000_000n);
	});

	it('attributes 0 to buyer for WithdrawDisputed (4) on V1 and V2', () => {
		// Alt 4 is admin-driven; admin wallet pays the on-chain fee. Buyer is
		// not debited here. Disputed payouts to buyer/seller are derived from
		// UTxO outputs by calculateValueChange in the DisputedWithdrawn branch.
		expect(getCardanoFeesBuyer(4, 1_000_000n, V1)).toBe(0n);
		expect(getCardanoFeesBuyer(4, 1_000_000n, V2)).toBe(0n);
	});

	it('attributes 0 to buyer for seller-only redeemers (0, 5, 6)', () => {
		// Alt 6 = AuthorizeRefund (seller). Previously misattributed to buyer
		// under the false rationale that V1 reused alt 6 for an admin flow —
		// the contract has a separate alt 4 for admin WithdrawDisputed.
		for (const sellerRedeemer of [0, 5, 6]) {
			expect(getCardanoFeesBuyer(sellerRedeemer, 1_000_000n, V1)).toBe(0n);
			expect(getCardanoFeesBuyer(sellerRedeemer, 1_000_000n, V2)).toBe(0n);
		}
	});

	it('attributes 0 to buyer for unknown redeemer versions', () => {
		expect(getCardanoFeesBuyer(99, 1_000_000n, V1)).toBe(0n);
		expect(getCardanoFeesBuyer(99, 1_000_000n, V2)).toBe(0n);
	});
});

describe('checkPaymentAmountsMatch', () => {
	const TOKEN = 'abc123.deadbeef';
	// Above CONSTANTS.MIN_COLLATERAL_LOVELACE (1_435_230n) so the collateral
	// clears the lower bound and only the locked-lovelace bound is exercised.
	const COLLATERAL = 5_000_000n;

	it('rejects a token-only request whose collateral exceeds the locked lovelace', () => {
		// Regression: a buyer locks the min-utxo ADA + the requested tokens but
		// sets collateral_return_lovelace above the locked ADA. Every seller
		// spend path (`lovelace_of(input) >= collateral_return_lovelace`) would
		// then abort forever, so tx-sync must reject the UTxO instead of adopting
		// the poisoned datum and letting the seller work for free.
		const expected = [{ unit: TOKEN, amount: 100n }];
		const actual = [
			{ unit: 'lovelace', quantity: '3000000' }, // 3 ADA locked < 5 ADA collateral
			{ unit: TOKEN, quantity: '100' },
		];
		expect(checkPaymentAmountsMatch(expected, actual, COLLATERAL)).toBe(false);
	});

	it('accepts a token-only request whose collateral fits within the locked lovelace', () => {
		const expected = [{ unit: TOKEN, amount: 100n }];
		const actual = [
			{ unit: 'lovelace', quantity: '6000000' }, // 6 ADA locked >= 5 ADA collateral
			{ unit: TOKEN, quantity: '100' },
		];
		expect(checkPaymentAmountsMatch(expected, actual, COLLATERAL)).toBe(true);
	});

	it('accepts a token-only request when collateral exactly equals the locked lovelace', () => {
		const expected = [{ unit: TOKEN, amount: 100n }];
		const actual = [
			{ unit: 'lovelace', quantity: '5000000' }, // 5 ADA locked == 5 ADA collateral
			{ unit: TOKEN, quantity: '100' },
		];
		expect(checkPaymentAmountsMatch(expected, actual, COLLATERAL)).toBe(true);
	});

	it('still bounds collateral for ADA-inclusive requests (unchanged behaviour)', () => {
		const expected = [
			{ unit: '', amount: 1_000_000n },
			{ unit: TOKEN, amount: 100n },
		];
		const actual = [
			{ unit: 'lovelace', quantity: '3000000' }, // 3 ADA locked < 5 ADA collateral
			{ unit: TOKEN, quantity: '100' },
		];
		expect(checkPaymentAmountsMatch(expected, actual, COLLATERAL)).toBe(false);
	});

	it('accepts a matching ADA-inclusive request with sufficient lovelace', () => {
		const expected = [
			{ unit: '', amount: 1_000_000n },
			{ unit: TOKEN, amount: 100n },
		];
		const actual = [
			{ unit: 'lovelace', quantity: '7000000' }, // covers 1 ADA payment + 5 ADA collateral
			{ unit: TOKEN, quantity: '100' },
		];
		expect(checkPaymentAmountsMatch(expected, actual, COLLATERAL)).toBe(true);
	});

	it('rejects negative collateral and sub-minimum collateral', () => {
		const expected = [{ unit: TOKEN, amount: 100n }];
		const actual = [
			{ unit: 'lovelace', quantity: '6000000' },
			{ unit: TOKEN, quantity: '100' },
		];
		expect(checkPaymentAmountsMatch(expected, actual, -1n)).toBe(false);
		expect(checkPaymentAmountsMatch(expected, actual, 1n)).toBe(false);
	});
});

describe('redeemerToOnChainState', () => {
	const noContract = null;
	const valueMatches = true;

	it('Withdraw (0) → Withdrawn', () => {
		expect(redeemerToOnChainState(0, noContract, valueMatches)).toBe(OnChainState.Withdrawn);
	});

	describe('RequestRefund (1)', () => {
		it('maps to RefundRequested when no result hash present', () => {
			expect(
				redeemerToOnChainState(1, { resultHash: null, state: SmartContractState.RefundRequested }, valueMatches),
			).toBe(OnChainState.RefundRequested);
		});

		it('maps to RefundRequested when result hash is empty string', () => {
			expect(
				redeemerToOnChainState(1, { resultHash: '', state: SmartContractState.RefundRequested }, valueMatches),
			).toBe(OnChainState.RefundRequested);
		});

		it('maps to Disputed when result hash is non-empty (result already submitted then refund-requested)', () => {
			expect(
				redeemerToOnChainState(1, { resultHash: 'abc123', state: SmartContractState.Disputed }, valueMatches),
			).toBe(OnChainState.Disputed);
		});
	});

	describe('AuthorizeWithdrawal / CancelRefund (2)', () => {
		it('maps to WithdrawAuthorized when new state is WithdrawAuthorized', () => {
			expect(
				redeemerToOnChainState(2, { resultHash: 'abc', state: SmartContractState.WithdrawAuthorized }, valueMatches),
			).toBe(OnChainState.WithdrawAuthorized);
		});

		it('maps to Disputed when cancel-refund leaves state=Disputed with a result hash', () => {
			expect(redeemerToOnChainState(2, { resultHash: 'abc', state: SmartContractState.Disputed }, valueMatches)).toBe(
				OnChainState.Disputed,
			);
		});

		it('maps to ResultSubmitted when cancel-refund leaves state=ResultSubmitted', () => {
			expect(
				redeemerToOnChainState(2, { resultHash: 'abc', state: SmartContractState.ResultSubmitted }, valueMatches),
			).toBe(OnChainState.ResultSubmitted);
		});

		it('maps to FundsLocked on cancel-refund without result hash when values match', () => {
			expect(redeemerToOnChainState(2, { resultHash: null, state: SmartContractState.FundsLocked }, valueMatches)).toBe(
				OnChainState.FundsLocked,
			);
		});

		it('maps to FundsOrDatumInvalid on cancel-refund without result hash when values mismatch (state-change attack defence)', () => {
			expect(redeemerToOnChainState(2, { resultHash: null, state: SmartContractState.FundsLocked }, false)).toBe(
				OnChainState.FundsOrDatumInvalid,
			);
		});
	});

	it('WithdrawRefund (3) → RefundWithdrawn', () => {
		expect(redeemerToOnChainState(3, noContract, valueMatches)).toBe(OnChainState.RefundWithdrawn);
	});

	it('WithdrawDisputed (4) → DisputedWithdrawn', () => {
		expect(redeemerToOnChainState(4, noContract, valueMatches)).toBe(OnChainState.DisputedWithdrawn);
	});

	describe('SubmitResult (5)', () => {
		it('maps to ResultSubmitted when new state is ResultSubmitted', () => {
			expect(
				redeemerToOnChainState(5, { resultHash: 'abc', state: SmartContractState.ResultSubmitted }, valueMatches),
			).toBe(OnChainState.ResultSubmitted);
		});

		it('maps to Disputed when SubmitResult races a RefundRequested (state stays Disputed)', () => {
			expect(redeemerToOnChainState(5, { resultHash: 'abc', state: SmartContractState.Disputed }, valueMatches)).toBe(
				OnChainState.Disputed,
			);
		});

		it('maps to Disputed when SubmitResult is performed on a RefundRequested input', () => {
			// State transition for the Disputed branch of submitResult — see
			// determineNewContractState in submit-result/service.ts.
			expect(
				redeemerToOnChainState(5, { resultHash: 'abc', state: SmartContractState.RefundRequested }, valueMatches),
			).toBe(OnChainState.Disputed);
		});
	});

	describe('AuthorizeRefund (6)', () => {
		it('maps to RefundAuthorized when new state is RefundAuthorized', () => {
			expect(
				redeemerToOnChainState(6, { resultHash: null, state: SmartContractState.RefundAuthorized }, valueMatches),
			).toBe(OnChainState.RefundAuthorized);
		});

		it('falls back to RefundRequested when state field is anything else', () => {
			expect(
				redeemerToOnChainState(6, { resultHash: null, state: SmartContractState.RefundRequested }, valueMatches),
			).toBe(OnChainState.RefundRequested);
		});
	});

	it('returns null for unknown redeemer versions', () => {
		expect(redeemerToOnChainState(99, noContract, valueMatches)).toBeNull();
	});
});
