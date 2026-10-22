import { OnChainState, PaymentAction, Prisma, PurchasingAction } from '@/generated/prisma/client';

/** A local observation timeout is not evidence that an initial escrow was invalid. */
export function isUnobservedLockTimeout(
	request: {
		onChainState: OnChainState | null;
		resultHash: string | null;
		currentTransactionId: string | null;
		CurrentTransaction: { id: string } | null;
		TransactionHistory: Array<{ txHash: string | null }>;
		currentHydraUtxoTxHash: string | null;
		currentHydraUtxoOutputIndex: number | null;
		currentHydraUtxoValue: Prisma.JsonValue | null;
		unresolvedHydraTerminalTxHash: string | null;
		unresolvedHydraTerminalReason: string | null;
		hydraFanoutHandoffHeadId?: string | null;
		NextAction: { requestedAction: PaymentAction | PurchasingAction };
	},
	observedState: OnChainState,
): boolean {
	return (
		observedState === OnChainState.FundsLocked &&
		request.onChainState === OnChainState.FundsOrDatumInvalid &&
		request.NextAction.requestedAction === PaymentAction.WaitingForManualAction &&
		request.resultHash == null &&
		request.currentTransactionId == null &&
		request.CurrentTransaction == null &&
		request.TransactionHistory.length === 0 &&
		request.currentHydraUtxoTxHash == null &&
		request.currentHydraUtxoOutputIndex == null &&
		request.currentHydraUtxoValue == null &&
		request.unresolvedHydraTerminalTxHash == null &&
		request.unresolvedHydraTerminalReason == null &&
		request.hydraFanoutHandoffHeadId == null
	);
}
