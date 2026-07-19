import { PaymentAction, PurchasingAction } from '@/generated/prisma/client';

export function getPaymentRetryAction(action: PaymentAction): PaymentAction | null {
	switch (action) {
		case PaymentAction.SubmitResultRequested:
		case PaymentAction.SubmitResultInitiated:
			return PaymentAction.SubmitResultRequested;
		case PaymentAction.WithdrawRequested:
		case PaymentAction.WithdrawInitiated:
			return PaymentAction.WithdrawRequested;
		case PaymentAction.AuthorizeRefundRequested:
		case PaymentAction.AuthorizeRefundInitiated:
			return PaymentAction.AuthorizeRefundRequested;
		default:
			return null;
	}
}

type PaymentActionWithResultHash = {
	requestedAction: PaymentAction;
	resultHash: string | null;
};

export function getPaymentRetryResultHash(
	errorResultHash: string | null,
	previousAction: PaymentActionWithResultHash | undefined,
	actionBeforePrevious: PaymentActionWithResultHash | undefined,
): string | null {
	if (
		previousAction == null ||
		getPaymentRetryAction(previousAction.requestedAction) !== PaymentAction.SubmitResultRequested
	) {
		return null;
	}

	if (errorResultHash != null) return errorResultHash;
	if (previousAction.resultHash != null) return previousAction.resultHash;

	if (
		previousAction.requestedAction === PaymentAction.SubmitResultInitiated &&
		actionBeforePrevious?.requestedAction === PaymentAction.SubmitResultRequested
	) {
		return actionBeforePrevious.resultHash;
	}

	return null;
}

export function getPurchaseRetryAction(action: PurchasingAction): PurchasingAction | null {
	switch (action) {
		case PurchasingAction.FundsLockingRequested:
		case PurchasingAction.FundsLockingInitiated:
			return PurchasingAction.FundsLockingRequested;
		case PurchasingAction.SetRefundRequestedRequested:
		case PurchasingAction.SetRefundRequestedInitiated:
			return PurchasingAction.SetRefundRequestedRequested;
		case PurchasingAction.UnSetRefundRequestedRequested:
		case PurchasingAction.UnSetRefundRequestedInitiated:
			return PurchasingAction.UnSetRefundRequestedRequested;
		case PurchasingAction.WithdrawRefundRequested:
		case PurchasingAction.WithdrawRefundInitiated:
			return PurchasingAction.WithdrawRefundRequested;
		case PurchasingAction.AuthorizeWithdrawalRequested:
		case PurchasingAction.AuthorizeWithdrawalInitiated:
			return PurchasingAction.AuthorizeWithdrawalRequested;
		default:
			return null;
	}
}
