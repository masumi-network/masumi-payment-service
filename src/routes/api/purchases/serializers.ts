import { PurchasingAction, PurchaseErrorType } from '@/generated/prisma/client';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';
import { transformPurchaseGetAmounts, transformPurchaseGetTimestamps } from '@/utils/shared/transformers';
import type { PurchaseListRecord } from './queries';

function serializePurchaseListEntry(purchase: PurchaseListRecord) {
	return {
		...purchase,
		...transformPurchaseGetTimestamps(purchase),
		...transformPurchaseGetAmounts(purchase),
		totalBuyerCardanoFees: Number(purchase.totalBuyerCardanoFees.toString()) / 1_000_000,
		totalSellerCardanoFees: Number(purchase.totalSellerCardanoFees.toString()) / 1_000_000,
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
