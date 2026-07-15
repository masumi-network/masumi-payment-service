import { PurchasingAction, PurchaseErrorType } from '@/generated/prisma/client';
import { lovelaceToAdaNumberSafe } from '@/utils/lovelace';
import {
	resolveAgentIdentifier,
	transformCurrentTransaction,
	transformPurchaseGetAmounts,
	transformPurchaseGetTimestamps,
	transformTransactionHistory,
} from '@/utils/shared/transformers';
import type { PurchaseListRecord } from './queries';

function serializePurchaseListEntry(purchase: PurchaseListRecord) {
	return {
		...purchase,
		...transformPurchaseGetTimestamps(purchase),
		...transformPurchaseGetAmounts(purchase),
		// safe: response schema is z.number() (ADA). lovelaceToAdaNumberSafe
		// throws if the lovelace value exceeds Number.MAX_SAFE_INTEGER instead
		// of silently losing precision.
		totalBuyerCardanoFees: lovelaceToAdaNumberSafe(purchase.totalBuyerCardanoFees),
		totalSellerCardanoFees: lovelaceToAdaNumberSafe(purchase.totalSellerCardanoFees),
		agentIdentifier: resolveAgentIdentifier(purchase),
		CurrentTransaction: transformCurrentTransaction(purchase.CurrentTransaction),
		TransactionHistory: transformTransactionHistory(purchase.TransactionHistory),
		ActionHistory: purchase.ActionHistory
			? (
					purchase.ActionHistory as Array<{
						id: string;
						createdAt: Date;
						updatedAt: Date;
						requestedAction: PurchasingAction;
						errorType: PurchaseErrorType | null;
						errorNote: string | null;
					}>
				).map((action) => ({
					id: action.id,
					createdAt: action.createdAt,
					updatedAt: action.updatedAt,
					requestedAction: action.requestedAction,
					errorType: action.errorType,
					errorNote: action.errorNote,
				}))
			: null,
	};
}

export function serializePurchasesResponse(purchases: PurchaseListRecord[]) {
	return {
		Purchases: purchases.map(serializePurchaseListEntry),
	};
}
