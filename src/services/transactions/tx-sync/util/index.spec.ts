import { OnChainState } from '@/generated/prisma/client';
import { SmartContractState } from '@/utils/generator/contract-generator';
import {
	getCardanoFeesBuyer,
	getCardanoFeesSeller,
	redeemerToOnChainState,
} from './index';

describe('getCardanoFeesSeller', () => {
	// V1: tx fees that benefited the seller are attributed to the seller. The
	// redeemer versions below mirror the Aiken `Action` enum in
	// smart-contracts/payment/validators/vested_pay.ak.
	it('attributes the share to seller for Withdraw (0)', () => {
		expect(getCardanoFeesSeller(0, 1_000_000n)).toBe(1_000_000n);
	});

	it('attributes the share to seller for SubmitResult (5)', () => {
		expect(getCardanoFeesSeller(5, 1_000_000n)).toBe(1_000_000n);
	});

	it('attributes the share to seller for AuthorizeRefund (6)', () => {
		// AuthorizeRefund is initiated by the seller cooperating with a
		// disputed refund — fee is the seller's responsibility.
		expect(getCardanoFeesSeller(6, 1_000_000n)).toBe(1_000_000n);
	});

	it('attributes 0 to seller for buyer-side redeemers', () => {
		for (const buyerRedeemer of [1, 2, 3, 4]) {
			expect(getCardanoFeesSeller(buyerRedeemer, 1_000_000n)).toBe(0n);
		}
	});

	it('attributes 0 to seller for unknown redeemer versions', () => {
		expect(getCardanoFeesSeller(99, 1_000_000n)).toBe(0n);
	});

	it('handles zero share without dividing', () => {
		expect(getCardanoFeesSeller(0, 0n)).toBe(0n);
	});
});

describe('getCardanoFeesBuyer', () => {
	it('attributes the share to buyer for RequestRefund (1)', () => {
		expect(getCardanoFeesBuyer(1, 1_000_000n)).toBe(1_000_000n);
	});

	it('attributes the share to buyer for CancelRefund / AuthorizeWithdrawal (2)', () => {
		expect(getCardanoFeesBuyer(2, 1_000_000n)).toBe(1_000_000n);
	});

	it('attributes the share to buyer for WithdrawRefund (3)', () => {
		expect(getCardanoFeesBuyer(3, 1_000_000n)).toBe(1_000_000n);
	});

	it('attributes the share to buyer for WithdrawDisputed (6 — admin)', () => {
		// V1 codepath shares redeemer 6 between AuthorizeRefund (seller-side)
		// and WithdrawDisputed (admin-driven refund payout to buyer). The
		// admin builder routes via `getCardanoFeesBuyer`. See
		// docs/adr/0005 / state machine docs for the dual-role of alt=6.
		expect(getCardanoFeesBuyer(6, 1_000_000n)).toBe(1_000_000n);
	});

	it('attributes 0 to buyer for seller-only redeemers (0, 5)', () => {
		expect(getCardanoFeesBuyer(0, 1_000_000n)).toBe(0n);
		expect(getCardanoFeesBuyer(5, 1_000_000n)).toBe(0n);
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
				redeemerToOnChainState(
					1,
					{ resultHash: null, state: SmartContractState.RefundRequested },
					valueMatches,
				),
			).toBe(OnChainState.RefundRequested);
		});

		it('maps to RefundRequested when result hash is empty string', () => {
			expect(
				redeemerToOnChainState(
					1,
					{ resultHash: '', state: SmartContractState.RefundRequested },
					valueMatches,
				),
			).toBe(OnChainState.RefundRequested);
		});

		it('maps to Disputed when result hash is non-empty (result already submitted then refund-requested)', () => {
			expect(
				redeemerToOnChainState(
					1,
					{ resultHash: 'abc123', state: SmartContractState.Disputed },
					valueMatches,
				),
			).toBe(OnChainState.Disputed);
		});
	});

	describe('AuthorizeWithdrawal / CancelRefund (2)', () => {
		it('maps to WithdrawAuthorized when new state is WithdrawAuthorized', () => {
			expect(
				redeemerToOnChainState(
					2,
					{ resultHash: 'abc', state: SmartContractState.WithdrawAuthorized },
					valueMatches,
				),
			).toBe(OnChainState.WithdrawAuthorized);
		});

		it('maps to Disputed when cancel-refund leaves state=Disputed with a result hash', () => {
			expect(
				redeemerToOnChainState(
					2,
					{ resultHash: 'abc', state: SmartContractState.Disputed },
					valueMatches,
				),
			).toBe(OnChainState.Disputed);
		});

		it('maps to ResultSubmitted when cancel-refund leaves state=ResultSubmitted', () => {
			expect(
				redeemerToOnChainState(
					2,
					{ resultHash: 'abc', state: SmartContractState.ResultSubmitted },
					valueMatches,
				),
			).toBe(OnChainState.ResultSubmitted);
		});

		it('maps to FundsLocked on cancel-refund without result hash when values match', () => {
			expect(
				redeemerToOnChainState(
					2,
					{ resultHash: null, state: SmartContractState.FundsLocked },
					valueMatches,
				),
			).toBe(OnChainState.FundsLocked);
		});

		it('maps to FundsOrDatumInvalid on cancel-refund without result hash when values mismatch (state-change attack defence)', () => {
			expect(
				redeemerToOnChainState(
					2,
					{ resultHash: null, state: SmartContractState.FundsLocked },
					false,
				),
			).toBe(OnChainState.FundsOrDatumInvalid);
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
				redeemerToOnChainState(
					5,
					{ resultHash: 'abc', state: SmartContractState.ResultSubmitted },
					valueMatches,
				),
			).toBe(OnChainState.ResultSubmitted);
		});

		it('maps to Disputed when SubmitResult races a RefundRequested (state stays Disputed)', () => {
			expect(
				redeemerToOnChainState(
					5,
					{ resultHash: 'abc', state: SmartContractState.Disputed },
					valueMatches,
				),
			).toBe(OnChainState.Disputed);
		});

		it('maps to Disputed when SubmitResult is performed on a RefundRequested input', () => {
			// State transition for the Disputed branch of submitResult — see
			// determineNewContractState in submit-result/service.ts.
			expect(
				redeemerToOnChainState(
					5,
					{ resultHash: 'abc', state: SmartContractState.RefundRequested },
					valueMatches,
				),
			).toBe(OnChainState.Disputed);
		});
	});

	describe('AuthorizeRefund (6)', () => {
		it('maps to RefundAuthorized when new state is RefundAuthorized', () => {
			expect(
				redeemerToOnChainState(
					6,
					{ resultHash: null, state: SmartContractState.RefundAuthorized },
					valueMatches,
				),
			).toBe(OnChainState.RefundAuthorized);
		});

		it('falls back to RefundRequested when state field is anything else', () => {
			expect(
				redeemerToOnChainState(
					6,
					{ resultHash: null, state: SmartContractState.RefundRequested },
					valueMatches,
				),
			).toBe(OnChainState.RefundRequested);
		});
	});

	it('returns null for unknown redeemer versions', () => {
		expect(redeemerToOnChainState(99, noContract, valueMatches)).toBeNull();
	});
});
