import { PaymentAction, PaymentErrorType } from '@/generated/prisma/client';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';
import { transformPaymentGetAmounts, transformPaymentGetTimestamps } from '@/utils/shared/transformers';
import type { PaymentListRecord } from './queries';

export function serializePaymentListEntry(payment: PaymentListRecord) {
	return {
		...payment,
		...transformPaymentGetTimestamps(payment),
		...transformPaymentGetAmounts(payment),
		totalBuyerCardanoFees: Number(payment.totalBuyerCardanoFees.toString()) / 1_000_000,
		totalSellerCardanoFees: Number(payment.totalSellerCardanoFees.toString()) / 1_000_000,
		agentIdentifier: decodeBlockchainIdentifier(payment.blockchainIdentifier)?.agentIdentifier ?? null,
		CurrentTransaction: payment.CurrentTransaction
			? {
					...payment.CurrentTransaction,
					fees: payment.CurrentTransaction.fees?.toString() ?? null,
				}
			: null,
		TransactionHistory: payment.TransactionHistory
			? payment.TransactionHistory.map((tx) => ({
					...tx,
					fees: tx.fees?.toString() ?? null,
				}))
			: null,
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
