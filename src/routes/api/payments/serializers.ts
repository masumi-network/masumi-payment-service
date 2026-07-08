import { PaymentAction, PaymentErrorType } from '@/generated/prisma/client';
import { lovelaceToAdaNumberSafe } from '@/utils/lovelace';
import {
	resolveAgentIdentifier,
	transformCurrentTransaction,
	transformPaymentGetAmounts,
	transformPaymentGetTimestamps,
	transformTransactionHistory,
} from '@/utils/shared/transformers';
import type { PaymentListRecord } from './queries';

export function serializePaymentListEntry(payment: PaymentListRecord) {
	return {
		...payment,
		...transformPaymentGetTimestamps(payment),
		...transformPaymentGetAmounts(payment),
		// safe: response schema is z.number() (ADA). lovelaceToAdaNumberSafe
		// throws if the lovelace value exceeds Number.MAX_SAFE_INTEGER instead
		// of silently losing precision.
		totalBuyerCardanoFees: lovelaceToAdaNumberSafe(payment.totalBuyerCardanoFees),
		totalSellerCardanoFees: lovelaceToAdaNumberSafe(payment.totalSellerCardanoFees),
		agentIdentifier: resolveAgentIdentifier(payment),
		CurrentTransaction: transformCurrentTransaction(payment.CurrentTransaction),
		TransactionHistory: transformTransactionHistory(payment.TransactionHistory),
		ActionHistory: payment.ActionHistory
			? (
					payment.ActionHistory as Array<{
						id: string;
						createdAt: Date;
						updatedAt: Date;
						submittedTxHash: string | null;
						requestedAction: PaymentAction;
						errorType: PaymentErrorType | null;
						errorNote: string | null;
						resultHash: string | null;
					}>
				).map((action) => ({
					id: action.id,
					createdAt: action.createdAt,
					updatedAt: action.updatedAt,
					submittedTxHash: action.submittedTxHash,
					requestedAction: action.requestedAction,
					errorType: action.errorType,
					errorNote: action.errorNote,
					resultHash: action.resultHash,
				}))
			: null,
	};
}

export function serializePaymentsResponse(payments: PaymentListRecord[]) {
	return {
		Payments: payments.map(serializePaymentListEntry),
	};
}
