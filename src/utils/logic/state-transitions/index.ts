import { OnChainState, PaymentErrorType } from '@/generated/prisma/client';
import { PaymentAction } from '@/generated/prisma/client';
import { PurchasingAction, PurchaseErrorType } from '@/generated/prisma/client';

//TODO: Check error notes and possibly new error types
const ERROR_MESSAGES = {
	INVALID_STATE_END:
		'Invalid state detected. Purchase request was in end state before. This indicates a database error or a bug',
	INVALID_STATE_EXTERNAL:
		'Invalid state detected. Someone else likely initiated a purchase request or this is a bug. Waiting for manual resolution',
	UNEXPECTED_STATE_CHANGE: 'Unexpected state change detected. This indicates a database error or a bug',
	UNEXPECTED_STATE_CHANGE_TIMEOUT: 'Unexpected state change detected. Possible a action could not be executed in time',
	UNEXPECTED_STATE_CHANGE_EXTERNAL: 'Unexpected state change detected. Possible a action was executed externally',
	AMOUNT_MISMATCH: 'Amount mismatch detected. Unexpected state change detected',
	AMOUNT_MISMATCH_END:
		'Amount mismatch detected. Invalid state detected. Purchase request was in end state before. This indicates a database error or a bug',
	MANUAL_ACTION_STATE_CHANGE: 'State change detected after manual action was required',
	AMOUNT_MISMATCH_MANUAL: 'Amount mismatch detected. State change detected after manual action was required',
};

function generatePurchasingActionAndErrorResult(
	currentAction: PurchasingAction,
	errorNote: string | null = null,
): {
	action: PurchasingAction;
	errorNote: string | null;
	errorType: PurchaseErrorType | null;
} {
	if (errorNote == null) {
		return { action: currentAction, errorNote: null, errorType: null };
	}
	return {
		action: currentAction,
		errorNote: errorNote,
		errorType: PurchaseErrorType.Unknown,
	};
}

function generatePaymentActionAndErrorResult(
	currentAction: PaymentAction,
	errorNote: string | null = null,
): {
	action: PaymentAction;
	errorNote: string | null;
	errorType: PaymentErrorType | null;
} {
	if (errorNote == null) {
		return { action: currentAction, errorNote: null, errorType: null };
	}
	return {
		action: currentAction,
		errorNote: errorNote,
		errorType: PaymentErrorType.Unknown,
	};
}

export function convertNewPurchasingActionAndError(
	currentAction: PurchasingAction,
	newState: OnChainState,
): {
	action: PurchasingAction;
	errorNote: string | null;
	errorType: PurchaseErrorType | null;
} {
	switch (currentAction) {
		case PurchasingAction.Ignore:
			return {
				action: PurchasingAction.Ignore,
				errorNote: null,
				errorType: null,
			};
		case PurchasingAction.FundsLockingInitiated:
			switch (newState) {
				case OnChainState.Disputed:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.INVALID_STATE_EXTERNAL,
					);
				case OnChainState.DisputedWithdrawn:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.INVALID_STATE_EXTERNAL,
					);
				case OnChainState.FundsLocked:
					return generatePurchasingActionAndErrorResult(PurchasingAction.WaitingForExternalAction);
				case OnChainState.FundsOrDatumInvalid:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.AMOUNT_MISMATCH_END,
					);
				case OnChainState.RefundRequested:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.INVALID_STATE_EXTERNAL,
					);
				case OnChainState.RefundWithdrawn:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.INVALID_STATE_EXTERNAL,
					);
				case OnChainState.ResultSubmitted:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.INVALID_STATE_EXTERNAL,
					);
				case OnChainState.Withdrawn:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.INVALID_STATE_EXTERNAL,
					);
			}
			break;
		case PurchasingAction.FundsLockingRequested:
			switch (newState) {
				case OnChainState.Disputed:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.INVALID_STATE_EXTERNAL,
					);
				case OnChainState.DisputedWithdrawn:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.INVALID_STATE_EXTERNAL,
					);
				case OnChainState.FundsLocked:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.INVALID_STATE_EXTERNAL,
					);
				case OnChainState.FundsOrDatumInvalid:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.AMOUNT_MISMATCH_END,
					);
				case OnChainState.RefundRequested:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.INVALID_STATE_EXTERNAL,
					);
				case OnChainState.RefundWithdrawn:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.INVALID_STATE_EXTERNAL,
					);
				case OnChainState.ResultSubmitted:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.INVALID_STATE_EXTERNAL,
					);
				case OnChainState.Withdrawn:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.INVALID_STATE_EXTERNAL,
					);
			}
			break;
		case PurchasingAction.None:
			switch (newState) {
				case OnChainState.Disputed:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.INVALID_STATE_END,
					);
				case OnChainState.DisputedWithdrawn:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.INVALID_STATE_END,
					);
				case OnChainState.FundsLocked:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.INVALID_STATE_END,
					);
				case OnChainState.FundsOrDatumInvalid:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.AMOUNT_MISMATCH_END,
					);
				case OnChainState.RefundRequested:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.INVALID_STATE_END,
					);
				case OnChainState.RefundWithdrawn:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.INVALID_STATE_END,
					);
				case OnChainState.ResultSubmitted:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.INVALID_STATE_END,
					);
				case OnChainState.Withdrawn:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.INVALID_STATE_END,
					);
			}
			break;
		case PurchasingAction.SetRefundRequestedInitiated:
			switch (newState) {
				case OnChainState.Disputed:
					return generatePurchasingActionAndErrorResult(PurchasingAction.WaitingForExternalAction);
				case OnChainState.DisputedWithdrawn:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
				case OnChainState.FundsLocked:
					return generatePurchasingActionAndErrorResult(PurchasingAction.SetRefundRequestedRequested);
				case OnChainState.FundsOrDatumInvalid:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
					);
				case OnChainState.RefundRequested:
					return generatePurchasingActionAndErrorResult(PurchasingAction.WaitingForExternalAction);
				case OnChainState.RefundWithdrawn:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
				case OnChainState.ResultSubmitted:
					return generatePurchasingActionAndErrorResult(PurchasingAction.SetRefundRequestedRequested);
				case OnChainState.Withdrawn:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
			}
			break;
		case PurchasingAction.SetRefundRequestedRequested:
			switch (newState) {
				case OnChainState.Disputed:
					return generatePurchasingActionAndErrorResult(PurchasingAction.SetRefundRequestedRequested);
				case OnChainState.DisputedWithdrawn:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
				case OnChainState.FundsLocked:
					return generatePurchasingActionAndErrorResult(PurchasingAction.SetRefundRequestedRequested);
				case OnChainState.FundsOrDatumInvalid:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
					);
				case OnChainState.RefundRequested:
					return generatePurchasingActionAndErrorResult(PurchasingAction.SetRefundRequestedRequested);
				case OnChainState.RefundWithdrawn:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
				case OnChainState.ResultSubmitted:
					return generatePurchasingActionAndErrorResult(PurchasingAction.SetRefundRequestedRequested);
				case OnChainState.Withdrawn:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
			}
			break;
		case PurchasingAction.UnSetRefundRequestedInitiated:
			switch (newState) {
				case OnChainState.Disputed:
					return generatePurchasingActionAndErrorResult(PurchasingAction.UnSetRefundRequestedRequested);
				case OnChainState.DisputedWithdrawn:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
				case OnChainState.FundsLocked:
					return generatePurchasingActionAndErrorResult(PurchasingAction.WaitingForExternalAction);
				case OnChainState.FundsOrDatumInvalid:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
					);
				case OnChainState.RefundRequested:
					return generatePurchasingActionAndErrorResult(PurchasingAction.UnSetRefundRequestedRequested);
				case OnChainState.RefundWithdrawn:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
				case OnChainState.ResultSubmitted:
					return generatePurchasingActionAndErrorResult(PurchasingAction.WaitingForExternalAction);
				case OnChainState.Withdrawn:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
			}
			break;
		case PurchasingAction.UnSetRefundRequestedRequested:
			switch (newState) {
				case OnChainState.Disputed:
					return generatePurchasingActionAndErrorResult(PurchasingAction.UnSetRefundRequestedRequested);
				case OnChainState.DisputedWithdrawn:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
				case OnChainState.FundsLocked:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
				case OnChainState.FundsOrDatumInvalid:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
					);
				case OnChainState.RefundRequested:
					return generatePurchasingActionAndErrorResult(PurchasingAction.UnSetRefundRequestedRequested);
				case OnChainState.RefundWithdrawn:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
				case OnChainState.ResultSubmitted:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
				case OnChainState.Withdrawn:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
			}
			break;
		case PurchasingAction.WaitingForExternalAction:
			switch (newState) {
				case OnChainState.Disputed:
					return generatePurchasingActionAndErrorResult(PurchasingAction.WaitingForExternalAction);
				case OnChainState.DisputedWithdrawn:
					return generatePurchasingActionAndErrorResult(PurchasingAction.None);
				case OnChainState.FundsLocked:
					return generatePurchasingActionAndErrorResult(PurchasingAction.WaitingForExternalAction);
				case OnChainState.FundsOrDatumInvalid:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
					);
				case OnChainState.RefundRequested:
					return generatePurchasingActionAndErrorResult(PurchasingAction.WaitingForExternalAction);
				case OnChainState.RefundWithdrawn:
					return generatePurchasingActionAndErrorResult(PurchasingAction.None);
				case OnChainState.ResultSubmitted:
					return generatePurchasingActionAndErrorResult(PurchasingAction.WaitingForExternalAction);
				case OnChainState.Withdrawn:
					return generatePurchasingActionAndErrorResult(PurchasingAction.None);
			}
			break;
		case PurchasingAction.WaitingForManualAction:
			switch (newState) {
				case OnChainState.Disputed:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.MANUAL_ACTION_STATE_CHANGE,
					);
				case OnChainState.DisputedWithdrawn:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.MANUAL_ACTION_STATE_CHANGE,
					);
				case OnChainState.FundsLocked:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.MANUAL_ACTION_STATE_CHANGE,
					);
				case OnChainState.FundsOrDatumInvalid:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
					);
				case OnChainState.RefundRequested:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.MANUAL_ACTION_STATE_CHANGE,
					);
				case OnChainState.RefundWithdrawn:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.MANUAL_ACTION_STATE_CHANGE,
					);
				case OnChainState.ResultSubmitted:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.MANUAL_ACTION_STATE_CHANGE,
					);
				case OnChainState.Withdrawn:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.MANUAL_ACTION_STATE_CHANGE,
					);
			}
			break;
		case PurchasingAction.WithdrawRefundInitiated:
			switch (newState) {
				case OnChainState.Disputed:
					return generatePurchasingActionAndErrorResult(PurchasingAction.WithdrawRefundRequested);
				case OnChainState.DisputedWithdrawn:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE,
					);
				case OnChainState.FundsLocked:
					return generatePurchasingActionAndErrorResult(PurchasingAction.WithdrawRefundRequested);
				case OnChainState.FundsOrDatumInvalid:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
					);
				case OnChainState.RefundRequested:
					return generatePurchasingActionAndErrorResult(PurchasingAction.WithdrawRefundRequested);
				case OnChainState.RefundWithdrawn:
					return generatePurchasingActionAndErrorResult(PurchasingAction.None);
				case OnChainState.ResultSubmitted:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE,
					);
				case OnChainState.Withdrawn:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE,
					);
			}
			break;
		case PurchasingAction.WithdrawRefundRequested:
			switch (newState) {
				case OnChainState.Disputed:
					return generatePurchasingActionAndErrorResult(PurchasingAction.WithdrawRefundRequested);
				case OnChainState.DisputedWithdrawn:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE,
					);
				case OnChainState.FundsLocked:
					return generatePurchasingActionAndErrorResult(PurchasingAction.WithdrawRefundRequested);
				case OnChainState.FundsOrDatumInvalid:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
					);
				case OnChainState.RefundRequested:
					return generatePurchasingActionAndErrorResult(PurchasingAction.WithdrawRefundRequested);
				case OnChainState.RefundWithdrawn:
					return generatePurchasingActionAndErrorResult(PurchasingAction.None);
				case OnChainState.ResultSubmitted:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE,
					);
				case OnChainState.Withdrawn:
					return generatePurchasingActionAndErrorResult(
						PurchasingAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
					);
			}
			break;
	}
	throw new Error(`Invalid state transition for ${currentAction} and ${newState}`);
}

export function convertNewPaymentActionAndError(
	currentAction: PaymentAction,
	newState: OnChainState,
): {
	action: PaymentAction;
	errorNote: string | null;
	errorType: PaymentErrorType | null;
} {
	switch (currentAction) {
		case PaymentAction.Ignore:
			return { action: PaymentAction.Ignore, errorNote: null, errorType: null };
		case PaymentAction.AuthorizeRefundInitiated:
			switch (newState) {
				case OnChainState.Disputed:
					return generatePaymentActionAndErrorResult(PaymentAction.AuthorizeRefundRequested);
				case OnChainState.DisputedWithdrawn:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
				case OnChainState.FundsLocked:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE,
					);
				case OnChainState.FundsOrDatumInvalid:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
					);
				case OnChainState.RefundRequested:
					return generatePaymentActionAndErrorResult(PaymentAction.WaitingForExternalAction);
				case OnChainState.RefundWithdrawn:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
				case OnChainState.ResultSubmitted:
					return generatePaymentActionAndErrorResult(
						PaymentAction.AuthorizeRefundRequested,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
				case OnChainState.Withdrawn:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
			}
			break;
		case PaymentAction.AuthorizeRefundRequested:
			switch (newState) {
				case OnChainState.Disputed:
					return generatePaymentActionAndErrorResult(PaymentAction.AuthorizeRefundRequested);
				case OnChainState.DisputedWithdrawn:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
				case OnChainState.FundsLocked:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE,
					);
				case OnChainState.FundsOrDatumInvalid:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
					);
				case OnChainState.RefundRequested:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
				case OnChainState.RefundWithdrawn:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
				case OnChainState.ResultSubmitted:
					return generatePaymentActionAndErrorResult(PaymentAction.AuthorizeRefundRequested);
				case OnChainState.Withdrawn:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
			}
			break;
		case PaymentAction.None:
			switch (newState) {
				case OnChainState.Disputed:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.INVALID_STATE_END,
					);
				case OnChainState.DisputedWithdrawn:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.INVALID_STATE_END,
					);
				case OnChainState.FundsLocked:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.INVALID_STATE_END,
					);
				case OnChainState.FundsOrDatumInvalid:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.AMOUNT_MISMATCH_END,
					);
				case OnChainState.RefundRequested:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.INVALID_STATE_END,
					);
				case OnChainState.RefundWithdrawn:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.INVALID_STATE_END,
					);
				case OnChainState.ResultSubmitted:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.INVALID_STATE_END,
					);
				case OnChainState.Withdrawn:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.INVALID_STATE_END,
					);
			}
			break;
		case PaymentAction.SubmitResultInitiated:
			switch (newState) {
				case OnChainState.Disputed:
					return generatePaymentActionAndErrorResult(PaymentAction.WaitingForExternalAction);
				case OnChainState.DisputedWithdrawn:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
				case OnChainState.FundsLocked:
					return generatePaymentActionAndErrorResult(PaymentAction.SubmitResultRequested);
				case OnChainState.FundsOrDatumInvalid:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
					);
				case OnChainState.RefundRequested:
					return generatePaymentActionAndErrorResult(PaymentAction.SubmitResultRequested);
				case OnChainState.RefundWithdrawn:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
				case OnChainState.ResultSubmitted:
					return generatePaymentActionAndErrorResult(PaymentAction.WaitingForExternalAction);
				case OnChainState.Withdrawn:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
			}
			break;
		case PaymentAction.SubmitResultRequested:
			switch (newState) {
				case OnChainState.Disputed:
					return generatePaymentActionAndErrorResult(PaymentAction.SubmitResultRequested);
				case OnChainState.DisputedWithdrawn:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
				case OnChainState.FundsLocked:
					return generatePaymentActionAndErrorResult(PaymentAction.SubmitResultRequested);
				case OnChainState.FundsOrDatumInvalid:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
					);
				case OnChainState.RefundRequested:
					return generatePaymentActionAndErrorResult(PaymentAction.SubmitResultRequested);
				case OnChainState.RefundWithdrawn:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
				case OnChainState.ResultSubmitted:
					return generatePaymentActionAndErrorResult(PaymentAction.SubmitResultRequested);
				case OnChainState.Withdrawn:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
			}
			break;
		case PaymentAction.WaitingForExternalAction:
			switch (newState) {
				case OnChainState.Disputed:
					return generatePaymentActionAndErrorResult(PaymentAction.WaitingForExternalAction);
				case OnChainState.DisputedWithdrawn:
					return generatePaymentActionAndErrorResult(PaymentAction.None);
				case OnChainState.FundsLocked:
					return generatePaymentActionAndErrorResult(PaymentAction.WaitingForExternalAction);
				case OnChainState.FundsOrDatumInvalid:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
					);
				case OnChainState.RefundRequested:
					return generatePaymentActionAndErrorResult(PaymentAction.WaitingForExternalAction);
				case OnChainState.RefundWithdrawn:
					return generatePaymentActionAndErrorResult(PaymentAction.None);
				case OnChainState.ResultSubmitted:
					return generatePaymentActionAndErrorResult(PaymentAction.WaitingForExternalAction);
				case OnChainState.Withdrawn:
					return generatePaymentActionAndErrorResult(PaymentAction.None);
			}
			break;
		case PaymentAction.WaitingForManualAction:
			switch (newState) {
				case OnChainState.Disputed:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.MANUAL_ACTION_STATE_CHANGE,
					);
				case OnChainState.DisputedWithdrawn:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.MANUAL_ACTION_STATE_CHANGE,
					);
				case OnChainState.FundsLocked:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.MANUAL_ACTION_STATE_CHANGE,
					);
				case OnChainState.FundsOrDatumInvalid:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
					);
				case OnChainState.RefundRequested:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.MANUAL_ACTION_STATE_CHANGE,
					);
				case OnChainState.RefundWithdrawn:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.MANUAL_ACTION_STATE_CHANGE,
					);
				case OnChainState.ResultSubmitted:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.MANUAL_ACTION_STATE_CHANGE,
					);
				case OnChainState.Withdrawn:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.MANUAL_ACTION_STATE_CHANGE,
					);
			}
			break;
		case PaymentAction.WithdrawInitiated:
			switch (newState) {
				case OnChainState.Disputed:
					return generatePaymentActionAndErrorResult(PaymentAction.WithdrawRequested);
				case OnChainState.DisputedWithdrawn:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
				case OnChainState.FundsLocked:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE,
					);
				case OnChainState.FundsOrDatumInvalid:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
					);
				case OnChainState.RefundRequested:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
				case OnChainState.RefundWithdrawn:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
				case OnChainState.ResultSubmitted:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
				case OnChainState.Withdrawn:
					return generatePaymentActionAndErrorResult(PaymentAction.None);
			}
			break;
		case PaymentAction.WithdrawRequested:
			switch (newState) {
				case OnChainState.Disputed:
					return generatePaymentActionAndErrorResult(PaymentAction.WithdrawRequested);
				case OnChainState.DisputedWithdrawn:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
				case OnChainState.FundsLocked:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE,
					);
				case OnChainState.FundsOrDatumInvalid:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
					);
				case OnChainState.RefundRequested:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
				case OnChainState.RefundWithdrawn:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
				case OnChainState.ResultSubmitted:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
					);
				case OnChainState.Withdrawn:
					return generatePaymentActionAndErrorResult(
						PaymentAction.WaitingForManualAction,
						ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
					);
			}
			break;
	}
	throw new Error(`Invalid state transition for ${currentAction} and ${newState}`);
}
