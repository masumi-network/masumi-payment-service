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
	txHash: string | null = null,
	l2?: { layer: TransactionLayer; hydraHeadId: string },
) {
	return {
		CurrentTransaction: {
			create: {
				txHash,
				status: TransactionStatus.Pending,
				layer: l2?.layer ?? TransactionLayer.L1,
				...(l2?.hydraHeadId ? { HydraHead: { connect: { id: l2.hydraHeadId } } } : {}),
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

/**
 * Connect a PRE-EXISTING PaymentActionData row as a PaymentRequest's NextAction.
 *
 * Use this paired with an explicit `tx.paymentActionData.create(...)` when the
 * caller needs to know the new action's id (e.g. a batch service that wants
 * to clean up the row in the failure path). The standard `createNextPaymentAction`
 * helper does a nested create whose returned id is not directly accessible.
 */
export function connectExistingNextPaymentAction(actionId: string) {
	return {
		NextAction: { connect: { id: actionId } },
	} satisfies Pick<Prisma.PaymentRequestUpdateInput, 'NextAction'>;
}

export function connectExistingNextPurchaseAction(actionId: string) {
	return {
		NextAction: { connect: { id: actionId } },
	} satisfies Pick<Prisma.PurchaseRequestUpdateInput, 'NextAction'>;
}

type SafeDeleteResult =
	| { deleted: true }
	| { deleted: false; reason: 'not-found' | 'in-history' | 'current-of-request' };

/**
 * Safely delete an orphan PaymentActionData row created during pre-submit
 * whose batch rolled back. Verifies inside the SAME Serializable transaction
 * that the row is not currently anyone's NextAction and is not in any
 * ActionHistory. If either check fails, the row is LEAKED (returned but not
 * deleted) — a leaked row is a minor audit drift; a deleted row that's
 * referenced elsewhere is data corruption.
 *
 * Caller MUST be inside a Serializable $transaction so the reference checks
 * are not racy against concurrent writers.
 */
export async function safeDeleteOrphanNextPaymentAction(
	tx: Prisma.TransactionClient,
	actionId: string,
): Promise<SafeDeleteResult> {
	const action = await tx.paymentActionData.findUnique({
		where: { id: actionId },
		select: {
			paymentRequestHistoryId: true,
			PaymentRequestCurrent: { select: { id: true } },
		},
	});
	if (action == null) return { deleted: false, reason: 'not-found' };
	if (action.paymentRequestHistoryId != null) return { deleted: false, reason: 'in-history' };
	if (action.PaymentRequestCurrent != null) return { deleted: false, reason: 'current-of-request' };
	await tx.paymentActionData.delete({ where: { id: actionId } });
	return { deleted: true };
}

export async function safeDeleteOrphanNextPurchaseAction(
	tx: Prisma.TransactionClient,
	actionId: string,
): Promise<SafeDeleteResult> {
	const action = await tx.purchaseActionData.findUnique({
		where: { id: actionId },
		select: {
			purchaseRequestHistoryId: true,
			PurchaseRequestCurrent: { select: { id: true } },
		},
	});
	if (action == null) return { deleted: false, reason: 'not-found' };
	if (action.purchaseRequestHistoryId != null) return { deleted: false, reason: 'in-history' };
	if (action.PurchaseRequestCurrent != null) return { deleted: false, reason: 'current-of-request' };
	await tx.purchaseActionData.delete({ where: { id: actionId } });
	return { deleted: true };
}
