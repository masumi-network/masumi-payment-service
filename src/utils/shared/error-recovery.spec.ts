import { describe, expect, it } from '@jest/globals';
import { PaymentAction, PurchasingAction } from '@/generated/prisma/client';
import { getPaymentRetryAction, getPaymentRetryResultHash, getPurchaseRetryAction } from './error-recovery';

describe('error recovery retry actions', () => {
	it.each([
		[PaymentAction.SubmitResultRequested, PaymentAction.SubmitResultRequested],
		[PaymentAction.SubmitResultInitiated, PaymentAction.SubmitResultRequested],
		[PaymentAction.WithdrawRequested, PaymentAction.WithdrawRequested],
		[PaymentAction.WithdrawInitiated, PaymentAction.WithdrawRequested],
		[PaymentAction.AuthorizeRefundRequested, PaymentAction.AuthorizeRefundRequested],
		[PaymentAction.AuthorizeRefundInitiated, PaymentAction.AuthorizeRefundRequested],
	])('maps payment action %s to %s', (action, expected) => {
		expect(getPaymentRetryAction(action)).toBe(expected);
	});

	it.each([
		PaymentAction.None,
		PaymentAction.Ignore,
		PaymentAction.WaitingForExternalAction,
		PaymentAction.WaitingForManualAction,
	])('does not retry non-transactional payment action %s', (action) => {
		expect(getPaymentRetryAction(action)).toBeNull();
	});

	it('restores a result hash from the failed requested action', () => {
		expect(
			getPaymentRetryResultHash(
				null,
				{ requestedAction: PaymentAction.SubmitResultRequested, resultHash: 'requested-hash' },
				undefined,
			),
		).toBe('requested-hash');
	});

	it('restores a result hash from an adjacent legacy initiated/requested pair', () => {
		expect(
			getPaymentRetryResultHash(
				null,
				{ requestedAction: PaymentAction.SubmitResultInitiated, resultHash: null },
				{ requestedAction: PaymentAction.SubmitResultRequested, resultHash: 'requested-hash' },
			),
		).toBe('requested-hash');
	});

	it('does not read a result hash from unrelated older history', () => {
		expect(
			getPaymentRetryResultHash(
				null,
				{ requestedAction: PaymentAction.SubmitResultInitiated, resultHash: null },
				{ requestedAction: PaymentAction.WaitingForExternalAction, resultHash: 'unrelated-hash' },
			),
		).toBeNull();
	});

	it.each([
		[PurchasingAction.FundsLockingRequested, PurchasingAction.FundsLockingRequested],
		[PurchasingAction.FundsLockingInitiated, PurchasingAction.FundsLockingRequested],
		[PurchasingAction.SetRefundRequestedRequested, PurchasingAction.SetRefundRequestedRequested],
		[PurchasingAction.SetRefundRequestedInitiated, PurchasingAction.SetRefundRequestedRequested],
		[PurchasingAction.UnSetRefundRequestedRequested, PurchasingAction.UnSetRefundRequestedRequested],
		[PurchasingAction.UnSetRefundRequestedInitiated, PurchasingAction.UnSetRefundRequestedRequested],
		[PurchasingAction.WithdrawRefundRequested, PurchasingAction.WithdrawRefundRequested],
		[PurchasingAction.WithdrawRefundInitiated, PurchasingAction.WithdrawRefundRequested],
	])('maps purchase action %s to %s', (action, expected) => {
		expect(getPurchaseRetryAction(action)).toBe(expected);
	});

	it.each([
		PurchasingAction.None,
		PurchasingAction.Ignore,
		PurchasingAction.WaitingForExternalAction,
		PurchasingAction.WaitingForManualAction,
	])('does not retry non-transactional purchase action %s', (action) => {
		expect(getPurchaseRetryAction(action)).toBeNull();
	});
});
