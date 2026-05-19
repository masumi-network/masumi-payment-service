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
});
