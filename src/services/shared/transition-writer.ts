import { PaymentAction, PurchasingAction, TransactionStatus } from '@/generated/prisma/client';

export function connectPreviousAction(nextActionId: string) {
	return {
		ActionHistory: {
			connect: {
				id: nextActionId,
			},
		},
	};
}

export function createPendingTransaction(blocksWalletId: string) {
	return {
		CurrentTransaction: {
			create: {
				txHash: null,
				status: TransactionStatus.Pending,
				BlocksWallet: {
					connect: {
						id: blocksWalletId,
					},
				},
			},
		},
	};
}

export function updateCurrentTransactionHash(txHash: string) {
	return {
		CurrentTransaction: {
			update: {
				txHash,
			},
		},
	};
}

export function updateCurrentTransactionStatus(status: TransactionStatus) {
	return {
		CurrentTransaction: {
			update: {
				status,
			},
		},
	};
}

export function createNextPaymentAction(requestedAction: PaymentAction, data: Record<string, unknown> = {}) {
	return {
		NextAction: {
			create: {
				requestedAction,
				...data,
			},
		},
	};
}

export function createNextPurchaseAction(requestedAction: PurchasingAction, data: Record<string, unknown> = {}) {
	return {
		NextAction: {
			create: {
				requestedAction,
				...data,
			},
		},
	};
}
