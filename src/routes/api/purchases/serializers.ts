import { PurchasingAction, PurchaseErrorType } from '@/generated/prisma/client';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';
import { lovelaceToAdaNumberSafe } from '@/utils/lovelace';
import { transformPurchaseGetAmounts, transformPurchaseGetTimestamps } from '@/utils/shared/transformers';
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
		agentIdentifier:
			purchase.agentIdentifier ?? decodeBlockchainIdentifier(purchase.blockchainIdentifier)?.agentIdentifier ?? null,
		CurrentTransaction: purchase.CurrentTransaction
			? {
					...purchase.CurrentTransaction,
					fees: purchase.CurrentTransaction.fees?.toString() ?? null,
				}
			: null,
		TransactionHistory:
			purchase.TransactionHistory != null
				? purchase.TransactionHistory.map((tx) => ({
						...tx,
						fees: tx.fees?.toString() ?? null,
					}))
				: null,
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
