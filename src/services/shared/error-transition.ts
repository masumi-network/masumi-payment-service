import {
	PaymentAction,
	PaymentErrorType,
	Prisma,
	PurchaseErrorType,
	PurchasingAction,
} from '@/generated/prisma/client';
import { webhookEventsService } from '@/services/webhooks/events.service';
import {
	connectPreviousAction,
	createNextPaymentAction,
	createNextPurchaseAction,
} from '@/services/shared/transition-writer';

type ErrorTransitionParams<TErrorType> = {
	requestId: string;
	nextActionId: string;
	errorNote: string;
	errorType?: TErrorType;
	unlockWallet?: boolean;
};

type PaymentErrorTransitionParams = ErrorTransitionParams<PaymentErrorType> & {
	resultHash?: string | null;
};

/**
 * Hand the request's wallet back, but only a lock a payment path could hold.
 *
 * `SmartContractWallet: { update: { lockedAt: null } }` cleared by relation and
 * so by wallet id alone. A Hydra L1 deposit claims the same hot wallet with
 * `lockPurpose` set, holds it across a full L1 confirmation and never attaches
 * a PendingTransaction, so a payment tick whose own lock had already been
 * reaped as stale freed the deposit's carve mid-flight — and the next batch
 * tick built over the carve's inputs, losing one of the two to BadInputsUTxO.
 */
async function unlockRequestWallet(
	tx: Prisma.TransactionClient,
	walletId: string | null,
	unlockWallet: boolean | undefined,
): Promise<void> {
	if (unlockWallet === false || walletId === null) return;
	await tx.hotWallet.updateMany({ where: { id: walletId, lockPurpose: null }, data: { lockedAt: null } });
}

export async function writePaymentErrorTransition(
	tx: Prisma.TransactionClient,
	params: PaymentErrorTransitionParams,
): Promise<void> {
	const request = await tx.paymentRequest.update({
		where: { id: params.requestId },
		data: {
			...connectPreviousAction(params.nextActionId),
			...createNextPaymentAction(PaymentAction.WaitingForManualAction, {
				errorType: params.errorType ?? PaymentErrorType.Unknown,
				errorNote: params.errorNote,
				...(params.resultHash !== undefined ? { resultHash: params.resultHash } : {}),
			}),
		},
	});
	await unlockRequestWallet(tx, request.smartContractWalletId, params.unlockWallet);
	await webhookEventsService.queuePaymentOnErrorInTransaction(tx, params.requestId);
}

export async function writePurchaseErrorTransition(
	tx: Prisma.TransactionClient,
	params: ErrorTransitionParams<PurchaseErrorType>,
): Promise<void> {
	const request = await tx.purchaseRequest.update({
		where: { id: params.requestId },
		data: {
			...connectPreviousAction(params.nextActionId),
			...createNextPurchaseAction(PurchasingAction.WaitingForManualAction, {
				errorType: params.errorType ?? PurchaseErrorType.Unknown,
				errorNote: params.errorNote,
			}),
		},
	});
	await unlockRequestWallet(tx, request.smartContractWalletId, params.unlockWallet);
	await webhookEventsService.queuePurchaseOnErrorInTransaction(tx, params.requestId);
}
