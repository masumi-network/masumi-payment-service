import { PaymentAction, Prisma, PurchasingAction, TransactionStatus } from '@/generated/prisma/client';

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

export function createPendingTransaction(blocksWalletId: string) {
	return {
		CurrentTransaction: {
			create: {
				txHash: null,
				status: TransactionStatus.Pending,
				// wallet-timeouts/service.ts filters by `PendingTransaction.lastCheckedAt: { lte: now-1min }`;
				// Prisma `lte` does not match NULL. Without an explicit timestamp here the row is
				// invisible to the cleanup cron and a crash between this create and the post-submit
				// txHash update would lock the wallet forever (BlocksWallet sets
				// HotWallet.pendingTransactionId which every `lockAndQueryX` filter requires to be null).
				// `now` debounces the first poll by 1 minute, comfortably longer than the
				// build/sign/submit window (~10-20s).
				lastCheckedAt: new Date(),
				BlocksWallet: {
					connect: {
						id: blocksWalletId,
					},
				},
			},
		},
	} satisfies Pick<Prisma.PaymentRequestUpdateInput, 'CurrentTransaction'>;
}

/**
 * For V2 batch multi-redeemer txs: reference an already-created shared
 * Transaction row from a participating PaymentRequest / PurchaseRequest.
 *
 * Call pattern: the batch service first creates ONE Transaction row with
 * `BlocksWallet` connect (the wallet that will sign the batch tx), capturing
 * its id; then for each of the N requests in the batch it spreads
 * `connectExistingTransaction(sharedTxId)` into the request update.
 *
 * This replaces the previous pattern of calling `createPendingTransaction`
 * once per request, which created N Transaction rows but — because the
 * `BlocksWallet` reverse-relation is 1-to-1 via `HotWallet.pendingTransactionId
 * @unique` — left N-1 of them orphaned. The single-Tx pattern guarantees a
 * deterministic wallet-unlock path during tx-sync (only the shared Tx carries
 * BlocksWallet, so unlock fires once per batch regardless of which entry
 * tx-sync processes first).
 */
export function connectExistingTransaction(transactionId: string) {
	return {
		CurrentTransaction: {
			connect: { id: transactionId },
		},
	} satisfies Pick<Prisma.PaymentRequestUpdateInput, 'CurrentTransaction'>;
}

export function disconnectTransactionWallet() {
	return {
		BlocksWallet: { disconnect: true },
	} satisfies Pick<Prisma.TransactionUpdateInput, 'BlocksWallet'>;
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
