import {
	PaymentAction,
	Prisma,
	PurchasingAction,
	TransactionLayer,
	TransactionStatus,
} from '@/generated/prisma/client';

type PaymentNextActionCreateData = Prisma.XOR<
	Omit<Prisma.PaymentActionDataCreateWithoutPaymentRequestCurrentInput, 'requestedAction'>,
	Omit<Prisma.PaymentActionDataUncheckedCreateWithoutPaymentRequestCurrentInput, 'requestedAction'>
>;

type PurchaseNextActionCreateData = Prisma.XOR<
	Omit<Prisma.PurchaseActionDataCreateWithoutPurchaseRequestCurrentInput, 'requestedAction'>,
	Omit<Prisma.PurchaseActionDataUncheckedCreateWithoutPurchaseRequestCurrentInput, 'requestedAction'>
>;

export function connectPreviousAction(nextActionId: string) {
	return {
		ActionHistory: {
			connect: {
				id: nextActionId,
			},
		},
	} satisfies Pick<Prisma.PaymentRequestUpdateInput, 'ActionHistory'>;
}

export function createPendingTransaction(
	blocksWalletId: string,
	l2?: { layer: TransactionLayer; hydraHeadId: string },
) {
	return {
		CurrentTransaction: {
			create: {
				txHash: null,
				status: TransactionStatus.Pending,
				layer: l2?.layer ?? TransactionLayer.L1,
				...(l2?.hydraHeadId ? { HydraHead: { connect: { id: l2.hydraHeadId } } } : {}),
				BlocksWallet: {
					connect: {
						id: blocksWalletId,
					},
				},
			},
		},
	} satisfies Pick<Prisma.PaymentRequestUpdateInput, 'CurrentTransaction'>;
}

export function updateCurrentTransactionHash(txHash: string) {
	return {
		CurrentTransaction: {
			update: {
				txHash,
			},
		},
	} satisfies Pick<Prisma.PaymentRequestUpdateInput, 'CurrentTransaction'>;
}

export function updateCurrentTransactionStatus(status: TransactionStatus) {
	return {
		CurrentTransaction: {
			update: {
				status,
			},
		},
	} satisfies Pick<Prisma.PaymentRequestUpdateInput, 'CurrentTransaction'>;
}

export function createNextPaymentAction(requestedAction: PaymentAction, data: PaymentNextActionCreateData = {}) {
	return {
		NextAction: {
			create: {
				requestedAction,
				...data,
			},
		},
	} satisfies Pick<Prisma.PaymentRequestUpdateInput, 'NextAction'>;
}

export function createNextPurchaseAction(requestedAction: PurchasingAction, data: PurchaseNextActionCreateData = {}) {
	return {
		NextAction: {
			create: {
				requestedAction,
				...data,
			},
		},
	} satisfies Pick<Prisma.PurchaseRequestUpdateInput, 'NextAction'>;
}
