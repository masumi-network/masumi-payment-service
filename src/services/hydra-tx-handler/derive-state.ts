import { OnChainState, PaymentAction, PurchasingAction } from '@/generated/prisma/client';

export function deriveExpectedOnChainState(
	action: string,
	currentOnChainState: OnChainState | null,
): OnChainState | null {
	switch (action) {
		case PaymentAction.SubmitResultInitiated:
			return currentOnChainState === OnChainState.RefundRequested || currentOnChainState === OnChainState.Disputed
				? OnChainState.Disputed
				: OnChainState.ResultSubmitted;
		case PaymentAction.WithdrawInitiated:
			return OnChainState.Withdrawn;
		case PaymentAction.AuthorizeRefundInitiated:
			return OnChainState.RefundRequested;
		case PurchasingAction.FundsLockingInitiated:
			return OnChainState.FundsLocked;
		case PurchasingAction.SetRefundRequestedInitiated:
			return currentOnChainState === OnChainState.ResultSubmitted || currentOnChainState === OnChainState.Disputed
				? OnChainState.Disputed
				: OnChainState.RefundRequested;
		case PurchasingAction.UnSetRefundRequestedInitiated:
			return currentOnChainState === OnChainState.Disputed ? OnChainState.ResultSubmitted : OnChainState.FundsLocked;
		case PurchasingAction.WithdrawRefundInitiated:
			return OnChainState.RefundWithdrawn;
		default:
			return null;
	}
}
