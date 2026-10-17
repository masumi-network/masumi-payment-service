import { Prisma, PurchaseErrorType, PurchasingAction } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';

/**
 * The L1 batch mutex is per process. Another replica can claim a request the
 * L1 batch selected (an L2 head lock, or a second L1 tick) between selection
 * and the L1 pre-submit write. Every L1 write to a request must therefore
 * prove the request is still in the state L1 selected, or that it still
 * belongs to the L1 shared transaction.
 */
type SelectedL1Request = {
	id: string;
	nextActionId: string;
	forceLayer: Prisma.PurchaseRequestGetPayload<object>['forceLayer'];
	paymentForceLayer: Prisma.PurchaseRequestGetPayload<object>['paymentForceLayer'];
};

export class L1PurchaseClaimLostError extends Error {
	constructor(readonly purchaseRequestId: string) {
		super(`Purchase request ${purchaseRequestId} was claimed by another writer before the L1 funds lock`);
		this.name = 'L1PurchaseClaimLostError';
	}
}

export function isRecordNotFoundError(error: unknown): boolean {
	return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}

/** Matches only while the request is still in the state the L1 batch selected. */
export function selectedL1RequestWhere(request: SelectedL1Request): Prisma.PurchaseRequestWhereUniqueInput {
	return {
		id: request.id,
		nextActionId: request.nextActionId,
		currentTransactionId: null,
		onChainState: null,
		forceLayer: request.forceLayer,
		paymentForceLayer: request.paymentForceLayer,
	};
}

/**
 * Claims one selected request for the L1 shared transaction. A failed match
 * throws `L1PurchaseClaimLostError`, which rolls back the whole pre-submit
 * transaction, so the batch never broadcasts.
 */
export async function claimSelectedL1Request(
	tx: Prisma.TransactionClient,
	request: SelectedL1Request,
	data: Prisma.PurchaseRequestUpdateInput,
): Promise<void> {
	try {
		await tx.purchaseRequest.update({ where: selectedL1RequestWhere(request), data, select: { id: true } });
	} catch (error) {
		if (isRecordNotFoundError(error)) {
			throw new L1PurchaseClaimLostError(request.id);
		}
		throw error;
	}
}

/**
 * Reverts the requests of a failed L1 batch. Only requests that still point at
 * this batch's shared transaction change. A request that the L1 batch never
 * claimed (the pre-submit write rolled back) or that another writer now owns
 * stays as it is.
 */
export async function revertOwnedL1BatchRequests(params: {
	sharedTxId: string | null;
	requests: Array<Pick<SelectedL1Request, 'id' | 'nextActionId'>>;
	isRetryable: boolean;
	errorNote: string;
}): Promise<void> {
	const { sharedTxId, requests, isRetryable, errorNote } = params;
	if (sharedTxId == null) {
		return;
	}
	for (const request of requests) {
		try {
			await prisma.purchaseRequest.update({
				where: { id: request.id, currentTransactionId: sharedTxId },
				data: {
					ActionHistory: { connect: { id: request.nextActionId } },
					NextAction: {
						create: isRetryable
							? { requestedAction: PurchasingAction.FundsLockingRequested, errorType: null, errorNote: null }
							: {
									requestedAction: PurchasingAction.WaitingForManualAction,
									errorType: PurchaseErrorType.Unknown,
									errorNote,
								},
					},
				},
				select: { id: true },
			});
		} catch (error) {
			if (!isRecordNotFoundError(error)) {
				throw error;
			}
			logger.info('batch-payments revert skipped a request the L1 batch does not own', {
				purchaseRequestId: request.id,
				sharedTxId,
			});
		}
	}
}
