import { OnChainState, PaymentAction, PurchasingAction } from '@/generated/prisma/client';
import { convertNewPaymentActionAndError, convertNewPurchasingActionAndError } from './index';

describe('V2 payment source state transitions', () => {
	it('keeps seller side waiting when withdrawal is authorized externally', () => {
		const result = convertNewPaymentActionAndError(
			PaymentAction.WaitingForExternalAction,
			OnChainState.WithdrawAuthorized,
		);

		expect(result).toEqual({
			action: PaymentAction.WaitingForExternalAction,
			errorNote: null,
			errorType: null,
		});
	});

	it('settles V2 refund authorization initiation back to external waiting', () => {
		const result = convertNewPaymentActionAndError(
			PaymentAction.AuthorizeRefundInitiated,
			OnChainState.RefundAuthorized,
		);

		expect(result).toEqual({
			action: PaymentAction.WaitingForExternalAction,
			errorNote: null,
			errorType: null,
		});
	});

	it('keeps buyer side waiting when withdrawal authorization is confirmed', () => {
		const result = convertNewPurchasingActionAndError(
			PurchasingAction.AuthorizeWithdrawalInitiated,
			OnChainState.WithdrawAuthorized,
		);

		expect(result).toEqual({
			action: PurchasingAction.WaitingForExternalAction,
			errorNote: null,
			errorType: null,
		});
	});

	it('leaves authorized refunds ready for refund withdrawal', () => {
		const result = convertNewPurchasingActionAndError(
			PurchasingAction.WithdrawRefundRequested,
			OnChainState.RefundAuthorized,
		);

		expect(result).toEqual({
			action: PurchasingAction.WithdrawRefundRequested,
			errorNote: null,
			errorType: null,
		});
	});

	it('treats UnSetRefundRequestedRequested+FundsLocked as the success target', () => {
		// V1 contract UnSetRefundRequested → FundsLocked when result_hash empty
		// (smart-contracts/payment/validators/vested_pay.ak:277-282). Symmetric
		// with UnSetRefundRequestedInitiated+FundsLocked (success), so the
		// Requested case should also resume external-action wait — NOT flag a
		// manual action.
		const result = convertNewPurchasingActionAndError(
			PurchasingAction.UnSetRefundRequestedRequested,
			OnChainState.FundsLocked,
		);

		expect(result).toEqual({
			action: PurchasingAction.WaitingForExternalAction,
			errorNote: null,
			errorType: null,
		});
	});

	it('treats UnSetRefundRequestedRequested+ResultSubmitted as the success target', () => {
		// V1 contract UnSetRefundRequested → ResultSubmitted when result_hash
		// non-empty (smart-contracts/payment/validators/vested_pay.ak:280-282).
		// Same rationale as the FundsLocked case above.
		const result = convertNewPurchasingActionAndError(
			PurchasingAction.UnSetRefundRequestedRequested,
			OnChainState.ResultSubmitted,
		);

		expect(result).toEqual({
			action: PurchasingAction.WaitingForExternalAction,
			errorNote: null,
			errorType: null,
		});
	});
});
