import { describe, it, expect } from '@jest/globals';
import { deriveExpectedOnChainState } from './derive-state';
import { OnChainState, PaymentAction, PurchasingAction } from '@/generated/prisma/client';

describe('deriveExpectedOnChainState', () => {
	describe('PaymentAction.SubmitResultInitiated', () => {
		it('returns Disputed when current state is RefundRequested', () => {
			const result = deriveExpectedOnChainState(PaymentAction.SubmitResultInitiated, OnChainState.RefundRequested);
			expect(result).toBe(OnChainState.Disputed);
		});

		it('returns Disputed when current state is Disputed', () => {
			const result = deriveExpectedOnChainState(PaymentAction.SubmitResultInitiated, OnChainState.Disputed);
			expect(result).toBe(OnChainState.Disputed);
		});

		it('returns ResultSubmitted when current state is FundsLocked', () => {
			const result = deriveExpectedOnChainState(PaymentAction.SubmitResultInitiated, OnChainState.FundsLocked);
			expect(result).toBe(OnChainState.ResultSubmitted);
		});

		it('returns ResultSubmitted when current state is null', () => {
			const result = deriveExpectedOnChainState(PaymentAction.SubmitResultInitiated, null);
			expect(result).toBe(OnChainState.ResultSubmitted);
		});
	});

	describe('PaymentAction.WithdrawInitiated', () => {
		it('returns Withdrawn regardless of current state', () => {
			expect(deriveExpectedOnChainState(PaymentAction.WithdrawInitiated, null)).toBe(OnChainState.Withdrawn);
			expect(deriveExpectedOnChainState(PaymentAction.WithdrawInitiated, OnChainState.ResultSubmitted)).toBe(
				OnChainState.Withdrawn,
			);
		});
	});

	describe('PaymentAction.AuthorizeRefundInitiated', () => {
		it('returns RefundRequested', () => {
			expect(deriveExpectedOnChainState(PaymentAction.AuthorizeRefundInitiated, null)).toBe(
				OnChainState.RefundRequested,
			);
		});
	});

	describe('PurchasingAction.FundsLockingInitiated', () => {
		it('returns FundsLocked', () => {
			expect(deriveExpectedOnChainState(PurchasingAction.FundsLockingInitiated, null)).toBe(OnChainState.FundsLocked);
		});
	});

	describe('PurchasingAction.SetRefundRequestedInitiated', () => {
		it('returns Disputed when current state is ResultSubmitted', () => {
			const result = deriveExpectedOnChainState(
				PurchasingAction.SetRefundRequestedInitiated,
				OnChainState.ResultSubmitted,
			);
			expect(result).toBe(OnChainState.Disputed);
		});

		it('returns Disputed when current state is Disputed', () => {
			const result = deriveExpectedOnChainState(PurchasingAction.SetRefundRequestedInitiated, OnChainState.Disputed);
			expect(result).toBe(OnChainState.Disputed);
		});

		it('returns RefundRequested when current state is FundsLocked', () => {
			const result = deriveExpectedOnChainState(PurchasingAction.SetRefundRequestedInitiated, OnChainState.FundsLocked);
			expect(result).toBe(OnChainState.RefundRequested);
		});

		it('returns RefundRequested when current state is null', () => {
			const result = deriveExpectedOnChainState(PurchasingAction.SetRefundRequestedInitiated, null);
			expect(result).toBe(OnChainState.RefundRequested);
		});
	});

	describe('PurchasingAction.UnSetRefundRequestedInitiated', () => {
		it('returns ResultSubmitted when current state is Disputed', () => {
			const result = deriveExpectedOnChainState(PurchasingAction.UnSetRefundRequestedInitiated, OnChainState.Disputed);
			expect(result).toBe(OnChainState.ResultSubmitted);
		});

		it('returns FundsLocked when current state is RefundRequested', () => {
			const result = deriveExpectedOnChainState(
				PurchasingAction.UnSetRefundRequestedInitiated,
				OnChainState.RefundRequested,
			);
			expect(result).toBe(OnChainState.FundsLocked);
		});

		it('returns FundsLocked when current state is null', () => {
			const result = deriveExpectedOnChainState(PurchasingAction.UnSetRefundRequestedInitiated, null);
			expect(result).toBe(OnChainState.FundsLocked);
		});
	});

	describe('PurchasingAction.WithdrawRefundInitiated', () => {
		it('returns RefundWithdrawn', () => {
			expect(deriveExpectedOnChainState(PurchasingAction.WithdrawRefundInitiated, null)).toBe(
				OnChainState.RefundWithdrawn,
			);
		});
	});

	describe('unknown action (default case)', () => {
		it('returns null for unrecognised action string', () => {
			const result = deriveExpectedOnChainState('UnknownAction' as PaymentAction, null);
			expect(result).toBeNull();
		});
	});
});
