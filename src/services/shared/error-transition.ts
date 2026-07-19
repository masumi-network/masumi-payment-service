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
};

export async function writePaymentErrorTransition(
	tx: Prisma.TransactionClient,
	params: ErrorTransitionParams<PaymentErrorType>,
): Promise<void> {
	await tx.paymentRequest.update({
		where: { id: params.requestId },
		data: {
			...connectPreviousAction(params.nextActionId),
			...createNextPaymentAction(PaymentAction.WaitingForManualAction, {
				errorType: params.errorType ?? PaymentErrorType.Unknown,
				errorNote: params.errorNote,
			}),
			SmartContractWallet: {
				update: {
					lockedAt: null,
				},
			},
		},
	});
	await webhookEventsService.queuePaymentOnErrorInTransaction(tx, params.requestId);
}

export async function writePurchaseErrorTransition(
	tx: Prisma.TransactionClient,
	params: ErrorTransitionParams<PurchaseErrorType>,
): Promise<void> {
	await tx.purchaseRequest.update({
		where: { id: params.requestId },
		data: {
			...connectPreviousAction(params.nextActionId),
			...createNextPurchaseAction(PurchasingAction.WaitingForManualAction, {
				errorType: params.errorType ?? PurchaseErrorType.Unknown,
				errorNote: params.errorNote,
			}),
			SmartContractWallet: {
				update: {
					lockedAt: null,
				},
			},
		},
	});
	await webhookEventsService.queuePurchaseOnErrorInTransaction(tx, params.requestId);
}
