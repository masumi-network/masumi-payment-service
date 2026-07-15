// GENERATED-THEN-REVIEWED transition tables. Derived 1:1 from the previous
// switch-tree implementation; behavior is locked by
// transition-matrix.fixture.json via index.spec.ts. To change a transition,
// edit the entry here AND regenerate the fixture (see spec header).
import { OnChainState, PaymentAction, PurchasingAction } from '@/generated/prisma/client';
import { ERROR_MESSAGES } from './error-messages';

export interface TransitionOutcome<TAction> {
	action: TAction;
	/** When set, the caller reports the transition as an Unknown-type error. */
	errorNote?: string;
}

export interface ActionTransitions<TAction> {
	/** Outcome for any on-chain state not listed in byState. */
	default: TransitionOutcome<TAction>;
	byState?: Partial<Record<OnChainState, TransitionOutcome<TAction>>>;
}

type TransitionTable<TAction extends string> = Record<TAction, ActionTransitions<TAction>>;

export const paymentTransitions: TransitionTable<PaymentAction> = {
	[PaymentAction.AuthorizeRefundInitiated]: {
		default: {
			action: PaymentAction.WaitingForManualAction,
			errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
		},
		byState: {
			[OnChainState.Disputed]: { action: PaymentAction.AuthorizeRefundRequested },
			[OnChainState.FundsLocked]: {
				action: PaymentAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE,
			},
			[OnChainState.FundsOrDatumInvalid]: {
				action: PaymentAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
			},
			[OnChainState.RefundAuthorized]: { action: PaymentAction.WaitingForExternalAction },
			[OnChainState.RefundRequested]: { action: PaymentAction.WaitingForExternalAction },
			[OnChainState.ResultSubmitted]: {
				action: PaymentAction.AuthorizeRefundRequested,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
			},
			[OnChainState.WithdrawAuthorized]: {
				action: PaymentAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
		},
	},
	[PaymentAction.AuthorizeRefundRequested]: {
		default: {
			action: PaymentAction.WaitingForManualAction,
			errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
		},
		byState: {
			[OnChainState.Disputed]: { action: PaymentAction.AuthorizeRefundRequested },
			[OnChainState.FundsLocked]: {
				action: PaymentAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE,
			},
			[OnChainState.FundsOrDatumInvalid]: {
				action: PaymentAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
			},
			[OnChainState.RefundAuthorized]: { action: PaymentAction.WaitingForExternalAction },
			[OnChainState.ResultSubmitted]: { action: PaymentAction.AuthorizeRefundRequested },
			[OnChainState.WithdrawAuthorized]: {
				action: PaymentAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
		},
	},
	[PaymentAction.Ignore]: {
		default: { action: PaymentAction.Ignore },
		byState: {
			[OnChainState.RefundAuthorized]: {
				action: PaymentAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
			[OnChainState.WithdrawAuthorized]: {
				action: PaymentAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
		},
	},
	[PaymentAction.None]: {
		default: { action: PaymentAction.WaitingForManualAction, errorNote: ERROR_MESSAGES.INVALID_STATE_END },
		byState: {
			[OnChainState.FundsOrDatumInvalid]: {
				action: PaymentAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.AMOUNT_MISMATCH_END,
			},
			[OnChainState.RefundAuthorized]: {
				action: PaymentAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
			[OnChainState.WithdrawAuthorized]: {
				action: PaymentAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
		},
	},
	[PaymentAction.SubmitResultInitiated]: {
		default: {
			action: PaymentAction.WaitingForManualAction,
			errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
		},
		byState: {
			[OnChainState.Disputed]: { action: PaymentAction.WaitingForExternalAction },
			[OnChainState.FundsLocked]: { action: PaymentAction.SubmitResultRequested },
			[OnChainState.FundsOrDatumInvalid]: {
				action: PaymentAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
			},
			[OnChainState.RefundAuthorized]: {
				action: PaymentAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
			[OnChainState.RefundRequested]: { action: PaymentAction.SubmitResultRequested },
			[OnChainState.ResultSubmitted]: { action: PaymentAction.WaitingForExternalAction },
			[OnChainState.WithdrawAuthorized]: {
				action: PaymentAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
		},
	},
	[PaymentAction.SubmitResultRequested]: {
		default: { action: PaymentAction.SubmitResultRequested },
		byState: {
			[OnChainState.DisputedWithdrawn]: {
				action: PaymentAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
			},
			[OnChainState.FundsOrDatumInvalid]: {
				action: PaymentAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
			},
			[OnChainState.RefundAuthorized]: {
				action: PaymentAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
			[OnChainState.RefundWithdrawn]: {
				action: PaymentAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
			},
			[OnChainState.WithdrawAuthorized]: {
				action: PaymentAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
			[OnChainState.Withdrawn]: {
				action: PaymentAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
			},
		},
	},
	[PaymentAction.WaitingForExternalAction]: {
		default: { action: PaymentAction.WaitingForExternalAction },
		byState: {
			[OnChainState.DisputedWithdrawn]: { action: PaymentAction.None },
			[OnChainState.FundsOrDatumInvalid]: {
				action: PaymentAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
			},
			[OnChainState.RefundWithdrawn]: { action: PaymentAction.None },
			[OnChainState.Withdrawn]: { action: PaymentAction.None },
		},
	},
	[PaymentAction.WaitingForManualAction]: {
		default: { action: PaymentAction.WaitingForManualAction, errorNote: ERROR_MESSAGES.MANUAL_ACTION_STATE_CHANGE },
		byState: {
			[OnChainState.FundsOrDatumInvalid]: {
				action: PaymentAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
			},
		},
	},
	[PaymentAction.WithdrawInitiated]: {
		default: {
			action: PaymentAction.WaitingForManualAction,
			errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
		},
		byState: {
			[OnChainState.Disputed]: { action: PaymentAction.WithdrawRequested },
			[OnChainState.FundsLocked]: {
				action: PaymentAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE,
			},
			[OnChainState.FundsOrDatumInvalid]: {
				action: PaymentAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
			},
			[OnChainState.RefundAuthorized]: {
				action: PaymentAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
			[OnChainState.WithdrawAuthorized]: { action: PaymentAction.WithdrawRequested },
			[OnChainState.Withdrawn]: { action: PaymentAction.None },
		},
	},
	[PaymentAction.WithdrawRequested]: {
		default: {
			action: PaymentAction.WaitingForManualAction,
			errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
		},
		byState: {
			[OnChainState.Disputed]: { action: PaymentAction.WithdrawRequested },
			[OnChainState.FundsLocked]: {
				action: PaymentAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE,
			},
			[OnChainState.FundsOrDatumInvalid]: {
				action: PaymentAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
			},
			[OnChainState.RefundAuthorized]: {
				action: PaymentAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
			[OnChainState.WithdrawAuthorized]: { action: PaymentAction.WithdrawRequested },
			[OnChainState.Withdrawn]: {
				action: PaymentAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
		},
	},
};

export const purchasingTransitions: TransitionTable<PurchasingAction> = {
	[PurchasingAction.AuthorizeWithdrawalInitiated]: {
		default: { action: PurchasingAction.WaitingForManualAction, errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE },
		byState: {
			[OnChainState.Disputed]: { action: PurchasingAction.AuthorizeWithdrawalRequested },
			[OnChainState.DisputedWithdrawn]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
			},
			[OnChainState.FundsOrDatumInvalid]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
			},
			[OnChainState.RefundAuthorized]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
			[OnChainState.RefundWithdrawn]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
			},
			[OnChainState.WithdrawAuthorized]: { action: PurchasingAction.WaitingForExternalAction },
			[OnChainState.Withdrawn]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
			},
		},
	},
	[PurchasingAction.AuthorizeWithdrawalRequested]: {
		default: { action: PurchasingAction.WaitingForManualAction, errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE },
		byState: {
			[OnChainState.Disputed]: { action: PurchasingAction.AuthorizeWithdrawalRequested },
			[OnChainState.DisputedWithdrawn]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
			},
			[OnChainState.FundsOrDatumInvalid]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
			},
			[OnChainState.RefundAuthorized]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
			[OnChainState.RefundWithdrawn]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
			},
			[OnChainState.WithdrawAuthorized]: { action: PurchasingAction.WaitingForExternalAction },
			[OnChainState.Withdrawn]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
			},
		},
	},
	[PurchasingAction.FundsLockingInitiated]: {
		default: { action: PurchasingAction.WaitingForManualAction, errorNote: ERROR_MESSAGES.INVALID_STATE_EXTERNAL },
		byState: {
			[OnChainState.FundsLocked]: { action: PurchasingAction.WaitingForExternalAction },
			[OnChainState.FundsOrDatumInvalid]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.AMOUNT_MISMATCH_END,
			},
			[OnChainState.RefundAuthorized]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
			[OnChainState.WithdrawAuthorized]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
		},
	},
	[PurchasingAction.FundsLockingRequested]: {
		default: { action: PurchasingAction.WaitingForManualAction, errorNote: ERROR_MESSAGES.INVALID_STATE_EXTERNAL },
		byState: {
			[OnChainState.FundsOrDatumInvalid]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.AMOUNT_MISMATCH_END,
			},
			[OnChainState.RefundAuthorized]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
			[OnChainState.WithdrawAuthorized]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
		},
	},
	[PurchasingAction.Ignore]: {
		default: { action: PurchasingAction.Ignore },
		byState: {
			[OnChainState.RefundAuthorized]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
			[OnChainState.WithdrawAuthorized]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
		},
	},
	[PurchasingAction.None]: {
		default: { action: PurchasingAction.WaitingForManualAction, errorNote: ERROR_MESSAGES.INVALID_STATE_END },
		byState: {
			[OnChainState.FundsOrDatumInvalid]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.AMOUNT_MISMATCH_END,
			},
			[OnChainState.RefundAuthorized]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
			[OnChainState.WithdrawAuthorized]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
		},
	},
	[PurchasingAction.SetRefundRequestedInitiated]: {
		default: {
			action: PurchasingAction.WaitingForManualAction,
			errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
		},
		byState: {
			[OnChainState.Disputed]: { action: PurchasingAction.WaitingForExternalAction },
			[OnChainState.FundsLocked]: { action: PurchasingAction.SetRefundRequestedRequested },
			[OnChainState.FundsOrDatumInvalid]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
			},
			[OnChainState.RefundAuthorized]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
			[OnChainState.RefundRequested]: { action: PurchasingAction.WaitingForExternalAction },
			[OnChainState.ResultSubmitted]: { action: PurchasingAction.SetRefundRequestedRequested },
			[OnChainState.WithdrawAuthorized]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
		},
	},
	[PurchasingAction.SetRefundRequestedRequested]: {
		default: { action: PurchasingAction.SetRefundRequestedRequested },
		byState: {
			[OnChainState.Disputed]: { action: PurchasingAction.WaitingForExternalAction },
			[OnChainState.DisputedWithdrawn]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
			},
			[OnChainState.FundsOrDatumInvalid]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
			},
			[OnChainState.RefundAuthorized]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
			[OnChainState.RefundWithdrawn]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
			},
			[OnChainState.WithdrawAuthorized]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
			[OnChainState.Withdrawn]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
			},
		},
	},
	[PurchasingAction.UnSetRefundRequestedInitiated]: {
		default: {
			action: PurchasingAction.WaitingForManualAction,
			errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
		},
		byState: {
			[OnChainState.Disputed]: { action: PurchasingAction.UnSetRefundRequestedRequested },
			[OnChainState.FundsLocked]: { action: PurchasingAction.WaitingForExternalAction },
			[OnChainState.FundsOrDatumInvalid]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
			},
			[OnChainState.RefundAuthorized]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
			[OnChainState.RefundRequested]: { action: PurchasingAction.UnSetRefundRequestedRequested },
			[OnChainState.ResultSubmitted]: { action: PurchasingAction.WaitingForExternalAction },
			[OnChainState.WithdrawAuthorized]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
		},
	},
	[PurchasingAction.UnSetRefundRequestedRequested]: {
		default: {
			action: PurchasingAction.WaitingForManualAction,
			errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_TIMEOUT,
		},
		byState: {
			[OnChainState.Disputed]: { action: PurchasingAction.UnSetRefundRequestedRequested },
			[OnChainState.FundsLocked]: { action: PurchasingAction.WaitingForExternalAction },
			[OnChainState.FundsOrDatumInvalid]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
			},
			[OnChainState.RefundAuthorized]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
			[OnChainState.RefundRequested]: { action: PurchasingAction.UnSetRefundRequestedRequested },
			[OnChainState.ResultSubmitted]: { action: PurchasingAction.WaitingForExternalAction },
			[OnChainState.WithdrawAuthorized]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
		},
	},
	[PurchasingAction.WaitingForExternalAction]: {
		default: { action: PurchasingAction.WaitingForExternalAction },
		byState: {
			[OnChainState.DisputedWithdrawn]: { action: PurchasingAction.None },
			[OnChainState.FundsOrDatumInvalid]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
			},
			[OnChainState.RefundWithdrawn]: { action: PurchasingAction.None },
			[OnChainState.Withdrawn]: { action: PurchasingAction.None },
		},
	},
	[PurchasingAction.WaitingForManualAction]: {
		default: { action: PurchasingAction.WaitingForManualAction, errorNote: ERROR_MESSAGES.MANUAL_ACTION_STATE_CHANGE },
		byState: {
			[OnChainState.FundsOrDatumInvalid]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
			},
		},
	},
	[PurchasingAction.WithdrawRefundInitiated]: {
		default: { action: PurchasingAction.WithdrawRefundRequested },
		byState: {
			[OnChainState.DisputedWithdrawn]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE,
			},
			[OnChainState.FundsOrDatumInvalid]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
			},
			[OnChainState.RefundWithdrawn]: { action: PurchasingAction.None },
			[OnChainState.ResultSubmitted]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE,
			},
			// V2 dispute→authorize→withdraw path: buyer raised `WithdrawRefund`
			// but the dispute resolved to seller-favored `AuthorizeWithdrawal`.
			// The buyer-side `WithdrawRefund*` action falls back to passive
			// waiting; the chain has moved on and the buyer's refund path is no
			// longer reachable from this UTxO. (Same for WithdrawRefundRequested
			// below.)
			[OnChainState.WithdrawAuthorized]: { action: PurchasingAction.WaitingForExternalAction },
			[OnChainState.Withdrawn]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE,
			},
		},
	},
	[PurchasingAction.WithdrawRefundRequested]: {
		default: { action: PurchasingAction.WithdrawRefundRequested },
		byState: {
			[OnChainState.DisputedWithdrawn]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE,
			},
			[OnChainState.FundsOrDatumInvalid]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.AMOUNT_MISMATCH_MANUAL,
			},
			[OnChainState.RefundWithdrawn]: { action: PurchasingAction.None },
			[OnChainState.ResultSubmitted]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE,
			},
			[OnChainState.WithdrawAuthorized]: { action: PurchasingAction.WaitingForExternalAction },
			[OnChainState.Withdrawn]: {
				action: PurchasingAction.WaitingForManualAction,
				errorNote: ERROR_MESSAGES.UNEXPECTED_STATE_CHANGE_EXTERNAL,
			},
		},
	},
};
